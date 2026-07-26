'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Republika Online (republika.co.id) adapter — Sprint 6a (S6a-B). camelCase raw adapter,
 * following the same fixture-first pattern as `src/adapters/sindonews/index.js` /
 * `src/adapters/okezone/index.js`. `./coreAdapter.js` bridges this to the snake_case
 * `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct HTTP fetches,
 * plain `User-Agent: EGIMediaCrawler/0.1`, no blocking observed):
 *
 *  - **robots.txt** (fetched live from `https://www.republika.co.id/robots.txt`): the
 *    default `User-Agent: *` group disallows `/search/?q=`, `/komentar/*`, `/copy/*`,
 *    `/cron/*`, `/curl/*`, `/feed/*`, `/post/*`, `/ajax/*`, and any `?utm_source=`/`?source=`
 *    query string — this adapter never touches any of those paths (discovery only ever hits
 *    `/indeks`/`/index/...` GET listing pages and article `/berita/...` pages). Separately, a
 *    long, explicit block-list of named crawler/AI-bot user agents (`Scrapy`, `news-please`,
 *    `GPTBot`, `ClaudeBot`, `CCBot`, `Bytespider`, `Diffbot`, `PerplexityBot`, ~30 more) each
 *    carry their own `Disallow: /`. Per the task brief ("use clear non-blacklisted product
 *    UA"), `CRAWLER_UA` is a plain product-style UA string (`EGIMediaCrawler/0.1`, matching
 *    every other adapter in this repo) — NOT any of those blacklisted tokens and NOT a
 *    browser-impersonating UA — so it only ever matches the permissive `User-Agent: *` group.
 *    `Sitemap: https://republika.co.id/files/xml/sitemap.xml` is also declared there (see
 *    "Secondary: sitemap" below).
 *  - **Multi-subdomain, ONE `source_id`.** Verified live from `/indeks`'s own listing hrefs
 *    that Republika serves articles from MANY vertical/regional subdomains, e.g.
 *    `ekonomi.republika.co.id`, `news.republika.co.id`, `khazanah.republika.co.id`,
 *    `rejabar.republika.co.id`, `rejogja.republika.co.id`, `ameera.republika.co.id`,
 *    `visual.republika.co.id`, `esgnow.republika.co.id` — every sampled article on every
 *    subdomain shares the exact same template (`NewsArticle` JSON-LD, `.article-content
 *    article` body, `.breadcrumb` DOM) — so, same treatment as `detik`/`okezone`/`sindonews`
 *    in this repo, ONE `source_id: "republika"` covers the whole brand; there is deliberately
 *    NO per-kanal or per-region adapter/source row. `isArticleUrl()` is therefore kept
 *    permissive on the HOST (`republika.co.id` bare, `www.`, or ANY subdomain) rather than an
 *    exhaustive per-kanal allowlist, mirroring `detik/index.js`'s "any subdomain" stance
 *    (detik's own module header) — the real gate is the URL PATH shape (see below).
 *  - **Article URL shape**: `https://{kanal-or-region}.republika.co.id/berita/{code}/{slug}`,
 *    e.g. `https://ekonomi.republika.co.id/berita/tio9zt472/gunhar-apresiasi-...`. `{code}`
 *    (verified live across ~40 sampled URLs) is consistently a 9-character lowercase
 *    alphanumeric token — kept as `[a-z0-9]{6,14}` for tolerance rather than hardcoding
 *    exactly 9 — and is reused as `external_article_id`. Verified live ONE malformed variant
 *    exists in the wild (seen directly in `/index/{offset}` output): a DOUBLE slash right
 *    after `berita`, e.g. `https://republika.co.id/berita//tio14w368/slug` (apparently a
 *    template bug for articles whose kanal subdomain resolves to the bare host) — `isArticleUrl
 *    ()`/`extractExternalId()` both parse path segments via `.split('/').filter(Boolean)`
 *    rather than a single anchored regex, so this malformed-but-recoverable shape is still
 *    correctly recognized as segments `["berita", "{code}", "{slug}"]` instead of being
 *    silently dropped.
 *  - **Discovery** (per task brief, all verified live):
 *      - `https://www.republika.co.id/indeks` — the default "Terkini" (latest, all-kanal-
 *        merged) listing, server-rendered `<ul class="wrap-latest">` of `<li class="list-
 *        group-item ... conten1">` cards. Its own in-page "Next" control is a client-side
 *        `data-offset="50"` button that POSTs to `/indeks/filter` (jQuery `$('#form-indeks')
 *        .submit()`) — NOT a plain GET link — so this adapter does not try to paginate `/indeks`
 *        itself; instead...
 *      - `https://republika.co.id/index/{offset}` (verified live, GET, step +50 per page —
 *        `offset=0` ≈ `/indeks` page 1, `offset=50` the next batch, etc.) is the plain-GET,
 *        all-kanal-merged pagination path `buildIndeksUrl({ offset })` builds by default.
 *      - `https://republika.co.id/index/{kanal}/{offset}` (verified live — the site's own
 *        "Kanal" sidebar links to exactly this shape, e.g. `/index/ekonomi/0`, `/index/
 *        trendtek/0`) scopes discovery to one vertical via `ctx.kanal`; step is again +50.
 *      - `https://republika.co.id/index/{offset}/{YYYY}/{MM}/{DD}` (verified live — the
 *        `/indeks` date-picker's own `<form id="form-indeks" action="/indeks/filter">`
 *        resolves to this GET-able shape once a specific day is chosen) scopes discovery to
 *        one calendar day via `ctx.date = { year, month, day }`; this is the ONLY listing
 *        variant observed to carry an ABSOLUTE, English-month timestamp in its `.kanal-info`
 *        sibling text ("20 July 2026, 23:40") — the plain `/indeks` and `/index/{offset}`
 *        variants only ever show a relative Indonesian string ("N menit/jam yang lalu"),
 *        which `parseListingDate()` cannot resolve (left `undefined`, same as every other
 *        adapter's relative-time listing hint).
 *      - **Regional seeds (rejabar, rejogja, etc.) are DEFERRED for Sprint 6a** per the task
 *        brief ("optional/nice-to-effort"). Regional articles are NOT excluded — they surface
 *        naturally through the all-kanal `/indeks` and `/index/{offset}` listings (verified
 *        live: `rejabar.republika.co.id`/`rejogja.republika.co.id` URLs already appear there,
 *        see the field matrix example above) and are fully parseable by `parse()` like any
 *        other kanal — but this adapter does NOT implement dedicated per-region seed URLs
 *        (e.g. a `rejabar.republika.co.id/indeks` walk) as its own discovery channel. A future
 *        sprint can add a `REGIONAL_KANAL_HOSTS` seed list analogous to `KANAL_HOSTS` below
 *        without touching `isArticleUrl()`/`parse()` at all.
 *  - **Secondary discovery** (per task brief):
 *      - RSS: `https://www.republika.co.id/rss` — verified live to carry exactly 15 `<item>`s
 *        (title/link/pubDate/dc:creator/category/media:content/description), matching the
 *        brief's "RSS ~15" note precisely.
 *      - Sitemap: `https://republika.co.id/files/xml/sitemap.xml` (declared in robots.txt) —
 *        verified live this is a single large `<urlset>` that mixes static `/kanal/...`
 *        navigation entries with a flat run of recent `<url><loc>.../berita/...</loc></url>`
 *        entries (each carrying `<image:image>`/`<lastmod>`) — `extractSitemapArticleUrls()`
 *        filters this down to just the `/berita/` entries per the task brief ("sitemap filter
 *        /berita/").
 *  - **Parse — standard hybrid JSON-LD/meta + DOM** (verified live on 2 independent samples
 *    across 2 different kanal subdomains):
 *      - Every article ships ONE `NewsArticle` JSON-LD block (no separate `WebPage`/
 *        `BreadcrumbList` block the way CNN Indonesia/SINDOnews do) with `headline`,
 *        `datePublished`/`dateModified` (both carrying an explicit `+07:00` offset; verified
 *        live these two are IDENTICAL on every sample — Republika does not appear to expose a
 *        genuine post-publish edit timestamp distinct from `datePublished` today), `image.url`
 *        (verified live this can be an EMPTY STRING `""` on some articles — treated as absent,
 *        falls through to `og:image`), `author.name`, and `description`.
 *      - **`author.name` caveat (verified live, worth flagging like CNN Indonesia's brand-only
 *        byline)**: the DOM byline block reads `"Rep: {reporter} / Red: {editor}"` — verified
 *        live on 2 samples that JSON-LD `author.name` always matches the "Red:" (editor) name,
 *        NOT the "Rep:" (reporter) name, and also matches the RSS feed's own `<dc:creator>`.
 *        This adapter treats JSON-LD `author.name` (the editor) as authoritative, matching the
 *        site's own structured-data semantics, with a DOM `"Red:"` fallback parse if JSON-LD
 *        is ever missing — the "Rep:" reporter name is NOT surfaced as `author_name` today.
 *      - `title` <- JSON-LD `headline` > DOM `.max-card__title h1` > `og:title` > `<title>`.
 *      - `summary` <- JSON-LD `description` > `og:description` > `meta[name=description]` >
 *        DOM `.max-card__teaser` (verified live identical text to `og:description`, kept as a
 *        last-resort fallback).
 *      - `category` <- DOM `.breadcrumb a` (last item, excluding the leading "Home" link —
 *        verified live e.g. "Home > Rejabar > News Rejabar", category = "News Rejabar"; this
 *        also matches the RSS `<category>` value for the same article) — no JSON-LD
 *        `BreadcrumbList` exists to prefer instead.
 *      - `tags` <- `meta[name="keywords"]` (comma-separated; verified live populated with real
 *        topical keywords, e.g. "komisi xii, produksi minyak, migas nasional, ..." — no
 *        taxonomy-label noise observed the way tirto's `news_keywords` has, so no stopword
 *        filtering is applied here, same treatment as `sindonews`).
 *      - `thumbnailUrl` <- JSON-LD `image.url` (when non-empty) > `og:image`.
 *      - `publishedAt`/`updatedAt` <- JSON-LD `datePublished`/`dateModified` (both already
 *        ISO 8601 with a `+07:00` offset — no defensive "assume WIB" parsing needed here,
 *        unlike tirto/suara's no-tz strings).
 *  - **Body**: DOM `.article-content article` (verified live selector on 2 samples). The raw
 *    markup wraps most real paragraphs in a malformed `<p class="b2">   <p>text</p></p>` —
 *    verified live via a direct cheerio/htmlparser2 parse that HTML5 paragraph-auto-closing
 *    rules turn this into TWO SIBLING `<p>` elements (an empty wrapper `<p class="b2">` right
 *    before the real, non-empty `<p>`), never a true nested tree — so a plain `.find('p')` +
 *    "drop empty text" filter (same pattern every other adapter in this repo already uses)
 *    naturally keeps exactly the real paragraphs with no special-casing required. Noise
 *    stripped before extraction: `script`/`style` (inline GPT/recreative ad snippets),
 *    `[id^="div-gpt-ad"]` ad slots, `[id^="bn_"]` (a third-party "recreative" widget id
 *    pattern verified live), `.picked-article` ("Baca Juga" link lists — a `<div><ul><li><a>`
 *    block, NOT itself wrapped in a `<p>`, but still explicitly stripped defensively since it
 *    sits inline between paragraphs), and `figcaption`/`.detail__media-caption` (photo credit/
 *    caption text). **No live multipage/pagination markup was found for the article BODY
 *    itself** — the `#next-article[data-max-pages]` + `/berita/serial/next` AJAX endpoint
 *    seen live is a "continuous scroll to the NEXT, DIFFERENT article" reading-feed feature
 *    (confirmed live: it POSTs `newsId`+`page` and appends an entirely separate article's
 *    markup after a `<hr>` "Halaman N / maxPages" divider), not pagination of the CURRENT
 *    article's own content — so `parse()` never follows it, same "no multipage" treatment
 *    tirto documents for an analogous reason.
 *
 * SAFETY: `discover()`'s live `/index/...` fetch only runs when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every other adapter in this repo) —
 * otherwise it reads the bundled `fixtures/republika/indeks.html` fixture, so simply
 * registering this adapter never causes surprise network traffic. `parse()` is fixture-first
 * when no `html` is supplied (or `ctx.fixtureOnly` is set), reading
 * `fixtures/republika/sample-article.html`.
 */

const SOURCE_ID = 'republika';
const BASE_URL = 'https://www.republika.co.id/';
const ALLOWED_HOST_SUFFIX = 'republika.co.id';
const INDEKS_URL = 'https://www.republika.co.id/indeks';
const INDEX_BASE_URL = 'https://republika.co.id/index';

// Known non-content subdomains verified live to serve static assets / files, never article
// pages — excluded defensively even though the `/berita/{code}/{slug}` path check alone would
// already never match anything served from them.
const NON_CONTENT_HOSTS = new Set(['static.republika.co.id', 'files.republika.co.id']);

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'republika');
const FIXTURE_INDEKS_PATH = path.join(FIXTURES_DIR, 'indeks.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range
const INDEX_PAGE_STEP = 50; // verified live `data-offset="50"` step on /indeks's own "Next" control

// `/berita/{code}/{slug}` — verified live `{code}` is consistently a ~9-char lowercase
// alphanumeric token; kept as a tolerant `{6,14}` range rather than hardcoding exactly 9.
const CODE_PATTERN = /^[a-z0-9]{6,14}$/;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

const EXTERNAL_ID_FROM_URL_PATTERN = /\/berita\/([a-z0-9]{6,14})(?:\/|$)/i;
const SITEMAP_ARTICLE_LOC_PATTERN = /<loc>\s*([^<\s]*\/berita\/[^<\s]*)\s*<\/loc>/gi;

// Elements stripped from `.article-content article` before pulling `<p>` text — see module
// header "Body" for the live-verified rationale behind each selector.
const BODY_NOISE_SELECTORS = [
  'script',
  'style',
  'ins',
  'iframe',
  '[id^="div-gpt-ad"]',
  '[id^="bn_"]',
  '.picked-article',
  '.footnote-wrap',
  'figcaption',
  '.detail__media-caption',
];

// English full month names, for the ONLY listing variant that carries an absolute timestamp —
// the date-scoped `/index/{offset}/{YYYY}/{MM}/{DD}` view (verified live format: "20 July
// 2026, 23:40"). The default `/indeks` and `/index/{offset}` views only ever show a relative
// Indonesian string ("N menit/jam yang lalu"), which is not parsed here (left undefined, same
// treatment every other adapter in this repo gives an unparseable relative listing hint).
const MONTH_INDEX = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

// Fixture "listing" used by discover() as an offline fallback when the bundled
// `fixtures/republika/indeks.html` fixture yields nothing (defensive belt-and-suspenders;
// the fixture itself is expected to always parse). Spans multiple kanal subdomains so an
// offline smoke test already exercises the "one source_id, many hosts" contract.
const FIXTURE_LISTING = [
  {
    rawUrl: 'https://ekonomi.republika.co.id/berita/contoh0001/contoh-judul-berita-republika-pertama',
    listingTitle: 'Contoh Judul Berita Republika Pertama',
    publishedHint: '7 menit yang lalu',
    categoryHint: 'Energi',
  },
  {
    rawUrl: 'https://rejabar.republika.co.id/berita/contoh0002/contoh-judul-berita-republika-kedua',
    listingTitle: 'Contoh Judul Berita Republika Kedua',
    publishedHint: '24 menit yang lalu',
    categoryHint: 'News Rejabar',
  },
];

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function readFixtureSafe(fixturePath) {
  try {
    return readFixture(fixturePath);
  } catch (_err) {
    return undefined;
  }
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Republika Online',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 30,
    overlapHours: 4,
    enabled: true,
  };
}

/**
 * @param {string} url
 * @returns {boolean} true iff `url`'s host is `republika.co.id`, `www.republika.co.id`, or any
 *   other `*.republika.co.id` subdomain NOT in `NON_CONTENT_HOSTS` — see module header "Multi-
 *   subdomain, ONE source_id".
 */
function isInScopeHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (NON_CONTENT_HOSTS.has(host)) return false;
    return host === ALLOWED_HOST_SUFFIX || host.endsWith(`.${ALLOWED_HOST_SUFFIX}`);
  } catch (_err) {
    return false;
  }
}

/**
 * @param {string} url
 * @returns {boolean} true iff `url` is a `/berita/{code}/{slug}` article on an in-scope
 *   Republika host. Parses path segments via `.split('/').filter(Boolean)` (rather than a
 *   single anchored regex on the raw pathname) so the live-verified malformed double-slash
 *   variant (`/berita//{code}/{slug}`, see module header) is still correctly recognized.
 */
function isArticleUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  if (!isInScopeHost(url)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return false;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 3 || segments[0].toLowerCase() !== 'berita') {
    return false;
  }
  return CODE_PATTERN.test(segments[1]) && SLUG_PATTERN.test(segments[2]);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url` (mirrors
 * every other adapter in this repo's `stripPageParam` — no live multipage query markup was
 * found for Republika's article pages themselves, see module header "Body").
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function stripPageParam(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('page');
    return parsed.toString();
  } catch (_err) {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the `{code}` path segment (works on both the well-formed and
 *   the live-verified malformed double-slash URL shape, see module header).
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 3 && segments[0].toLowerCase() === 'berita' && CODE_PATTERN.test(segments[1])) {
      return segments[1];
    }
  } catch (_err) {
    // fall through to the regex fallback below
  }
  const match = EXTERNAL_ID_FROM_URL_PATTERN.exec(url);
  return match ? match[1] : undefined;
}

/**
 * @param {string} url
 * @returns {string|undefined} the kanal/region subdomain label (e.g. "ekonomi", "rejabar"),
 *   used only as a discovery-time category hint — the authoritative `category` on the parsed
 *   article comes from the DOM breadcrumb (see module header "Parse").
 */
function extractKanalHint(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === ALLOWED_HOST_SUFFIX || host === `www.${ALLOWED_HOST_SUFFIX}`) return undefined;
    return host.endsWith(`.${ALLOWED_HOST_SUFFIX}`) ? host.slice(0, -(`.${ALLOWED_HOST_SUFFIX}`.length)) : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {{offset?: number|string, kanal?: string, date?: {year: number|string, month: number|string, day: number|string}}} [opts]
 * @returns {string} `/index/{offset}`, `/index/{kanal}/{offset}`, or
 *   `/index/{offset}/{YYYY}/{MM}/{DD}` — see module header "Discovery" for which shape is
 *   used when.
 */
function buildIndeksUrl({ offset = 0, kanal, date } = {}) {
  const safeOffset = Number.isFinite(Number(offset)) && Number(offset) >= 0 ? Math.floor(Number(offset)) : 0;
  const segments = [INDEX_BASE_URL];
  if (kanal) {
    segments.push(encodeURIComponent(kanal), String(safeOffset));
  } else {
    segments.push(String(safeOffset));
  }
  if (date && date.year && date.month && date.day) {
    segments.push(String(date.year), String(date.month).padStart(2, '0'), String(date.day).padStart(2, '0'));
  }
  return segments.join('/');
}

/**
 * @param {string} text - e.g. "20 July 2026, 23:40" (only the date-scoped listing carries
 *   this absolute, English-month shape — see module header "Discovery").
 * @returns {string|undefined} ISO 8601 string (assumes Asia/Jakarta local time, `+07:00`,
 *   matching every other no-explicit-tz listing timestamp in this repo), or undefined if the
 *   text doesn't match (e.g. the relative "N menit/jam yang lalu" strings from the default
 *   `/indeks`/`/index/{offset}` listings).
 */
function parseListingDate(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Parses an `/indeks` (or `/index/...`) listing page into discovery entries. Each entry is a
 * `<li class="list-group-item list-border conten1"><a href="..."><div class="caption"><div
 * class="date"><span class="kanal-info">Kanal Label</span> - N menit yang lalu</div><h3>
 * <span>Title</span></h3></div></a></li>` (verified live 2026-07-24).
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function extractIndeksItems(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('li.list-group-item a[href]').each((_, el) => {
    if (items.length >= limit) return;
    const $anchor = $(el);
    const href = $anchor.attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    const dateText = $anchor.find('.date').first().text().trim();
    const kanalLabel = $anchor.find('.kanal-info').first().text().trim();
    const publishedHint = kanalLabel && dateText.includes(kanalLabel) ? dateText.slice(kanalLabel.length).replace(/^\s*-\s*/, '').trim() : dateText || undefined;

    items.push({
      rawUrl: href,
      listingTitle: $anchor.find('h3').first().text().trim() || undefined,
      publishedHint: publishedHint || undefined,
      categoryHint: kanalLabel || extractKanalHint(href),
      externalId: extractExternalId(href),
    });
  });

  return items;
}

/**
 * @param {{offset?, kanal?, date?, limit?: number, logger?: {warn?: Function}}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx = {}) {
  const limit = Number.isInteger(ctx && ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const indeksUrl = buildIndeksUrl({ offset: ctx.offset, kanal: ctx.kanal, date: ctx.date });

  const response = await axios.get(indeksUrl, {
    headers: { 'User-Agent': CRAWLER_UA },
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'text',
  });

  if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
    return { items: [] };
  }

  const entries = extractIndeksItems(response.data, limit);
  const items = entries.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: stripPageParam(entry.rawUrl),
    discoveryChannel: 'indeks',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    categoryHint: entry.categoryHint,
    externalId: entry.externalId,
  }));

  return { items };
}

/**
 * @param {{offset?, kanal?, date?, limit?, liveDiscover?: boolean, logger?}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx && ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;

  if (isLiveDiscoverEnabled(ctx)) {
    try {
      const live = await discoverLive(ctx);
      if (live.items.length > 0) {
        return live;
      }
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('[republika] discover(): live /index fetch returned 0 matching article URL(s); falling back to fixture listing');
      }
    } catch (err) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`[republika] discover(): live /index fetch failed (${err.message}); falling back to fixture listing`);
      }
    }
  }

  const fixtureHtml = readFixtureSafe(FIXTURE_INDEKS_PATH);
  const fixtureItems = fixtureHtml ? extractIndeksItems(fixtureHtml, limit) : [];
  const entries = fixtureItems.length > 0 ? fixtureItems : FIXTURE_LISTING.map((entry) => ({ ...entry, externalId: extractExternalId(entry.rawUrl) }));

  return {
    items: entries.slice(0, limit).map((entry) => ({
      rawUrl: entry.rawUrl,
      normalizedUrl: stripPageParam(entry.rawUrl),
      discoveryChannel: 'fixture',
      listingTitle: entry.listingTitle,
      publishedHint: entry.publishedHint,
      categoryHint: entry.categoryHint,
      externalId: entry.externalId,
    })),
  };
}

/**
 * Extracts `/berita/`-only article URLs from a raw sitemap XML string via a plain regex scan
 * (the sitemap mixes plain `/kanal/...` navigation `<loc>` entries with article `<loc>`
 * entries in one flat `<urlset>` — see module header "Secondary discovery"). A regex scan
 * (rather than a full XML parser dependency) mirrors this repo's existing "no new heavy
 * dependency for a secondary/best-effort channel" posture.
 * @param {string} xml
 * @returns {string[]}
 */
function extractSitemapArticleUrls(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const urls = [];
  let match;
  SITEMAP_ARTICLE_LOC_PATTERN.lastIndex = 0;
  while ((match = SITEMAP_ARTICLE_LOC_PATTERN.exec(xml)) !== null) {
    const url = match[1].trim();
    if (isArticleUrl(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Parses a raw RSS 2.0 XML string (`https://www.republika.co.id/rss`, verified live to carry
 * exactly 15 `<item>`s) via a plain regex/string scan into discovery-shaped entries — same
 * "no new XML dependency for a secondary channel" posture as `extractSitemapArticleUrls()`.
 * @param {string} xml
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, categoryHint?: string}>}
 */
function extractRssItems(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  for (const block of itemBlocks) {
    const link = (/<link>\s*([^<\s]+)\s*<\/link>/i.exec(block) || [])[1];
    if (!link || !isArticleUrl(link)) continue;

    const title = (/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block) || [])[1];
    const pubDate = (/<pubDate>\s*([^<]+)\s*<\/pubDate>/i.exec(block) || [])[1];
    const category = (/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/i.exec(block) || [])[1];

    items.push({
      rawUrl: link,
      listingTitle: title ? title.trim() : undefined,
      publishedHint: pubDate ? pubDate.trim() : undefined,
      categoryHint: category ? category.trim() : extractKanalHint(link),
    });
  }

  return items;
}

/**
 * @param {string} raw - JSON-LD script text.
 * @returns {object[]}
 */
function parseJsonLdBlock($, el) {
  const raw = $(el).contents().text();
  if (!raw || !raw.trim()) return [];
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data['@graph'])) return data['@graph'];
    return data ? [data] : [];
  } catch (_err) {
    return [];
  }
}

function extractJsonLd($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    blocks.push(...parseJsonLdBlock($, el));
  });
  return blocks;
}

function findNewsArticleLd(blocks) {
  return blocks.find((block) => {
    const type = block && block['@type'];
    if (!type) return false;
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => typeof t === 'string' && /article/i.test(t));
  });
}

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {object|undefined} articleLd
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined} best-effort author. Per module header "author.name caveat",
 *   JSON-LD `author.name` reflects the DOM `"Red:"` (editor) byline, not `"Rep:"` (reporter) —
 *   treated as authoritative regardless, matching the site's own structured-data semantics. The
 *   DOM fallback (used only if JSON-LD is absent) parses the same `"Red:"` name for consistency.
 */
function extractAuthorName(articleLd, $) {
  const ldName = articleLd && articleLd.author && articleLd.author.name;
  if (typeof ldName === 'string' && ldName.trim()) {
    return ldName.trim();
  }
  const bylineText = $('.max-card__title > div').last().text().trim();
  const redMatch = /Red\s*:\s*([^/]+)$/i.exec(bylineText);
  if (redMatch) return redMatch[1].trim();
  return bylineText || undefined;
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined} the most specific (last) breadcrumb label, excluding the
 *   leading "Home" link (e.g. "Home > Rejabar > News Rejabar" -> "News Rejabar") — verified
 *   live selector `.breadcrumb a`. No JSON-LD `BreadcrumbList` exists to prefer instead (see
 *   module header "Parse").
 */
function extractCategory($) {
  const labels = $('.breadcrumb a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((label) => label && label.toLowerCase() !== 'home');
  return labels.length > 0 ? labels[labels.length - 1] : undefined;
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]} `meta[name="keywords"]` comma-split — verified live populated with real
 *   topical keywords, no taxonomy-label filtering needed (see module header "Parse").
 */
function extractTags($) {
  const raw = $('meta[name="keywords"]').attr('content') || '';
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Removes known noise (ad/"recreative" widget scaffolding, "Baca Juga" picked-article lists,
 * photo captions, scripts/styles) from a clone of the article body, then returns the cleaned-
 * up `<p>` text as paragraphs. See module header "Body" for why a plain `.find('p')` + "drop
 * empty text" filter is sufficient here (the raw markup's `<p class="b2"><p>...</p></p>`
 * malformed nesting is auto-corrected into empty-then-real SIBLING `<p>` elements by HTML5
 * paragraph-auto-closing rules, verified live via a direct cheerio parse).
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio} bodyEl
 * @returns {string[]}
 */
function extractParagraphs($, bodyEl) {
  if (!bodyEl || bodyEl.length === 0) return [];

  const cleaned = bodyEl.clone();
  cleaned.find(BODY_NOISE_SELECTORS.join(', ')).remove();

  return cleaned
    .find('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);
  const ldBlocks = extractJsonLd($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};

  const canonicalUrlRaw =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && articleLd.mainEntityOfPage['@id']) ||
    (ctx && ctx.url);
  const canonicalUrl = canonicalUrlRaw ? stripPageParam(canonicalUrlRaw) : undefined;

  const url = (ctx && ctx.url) || canonicalUrl || FIXTURE_LISTING[0].rawUrl;

  const title =
    articleLd.headline ||
    $('.max-card__title h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author = extractAuthorName(articleLd, $);

  const publishedAt = toIsoOrUndefined(articleLd.datePublished);
  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const summary =
    articleLd.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('.max-card__teaser').first().text().trim() ||
    undefined;

  const ldImage = articleLd.image;
  const ldImageUrl = ldImage && (typeof ldImage === 'string' ? ldImage : ldImage.url);
  const thumbnailUrl = (ldImageUrl && ldImageUrl.trim()) || $('meta[property="og:image"]').attr('content') || undefined;

  const category = extractCategory($);
  const tags = extractTags($);
  const externalArticleId = extractExternalId(canonicalUrl || url || '');

  const bodyEl = $('.article-content article').first();
  const paragraphs = extractParagraphs($, bodyEl);

  return {
    sourceId: SOURCE_ID,
    url,
    canonicalUrl,
    title,
    author,
    publishedAt,
    updatedAt,
    summary,
    thumbnailUrl,
    category,
    tags,
    externalArticleId,
    paragraphs,
    rawHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/republika/smoke-test.js) and for
  // debugging extraction logic in isolation.
  buildIndeksUrl,
  extractIndeksItems,
  extractExternalId,
  extractKanalHint,
  extractCategory,
  extractTags,
  extractParagraphs,
  extractSitemapArticleUrls,
  extractRssItems,
  parseListingDate,
  stripPageParam,
  discoverLive,
  isLiveDiscoverEnabled,
  NON_CONTENT_HOSTS,
  FIXTURE_INDEKS_PATH,
  FIXTURE_ARTICLE_PATH,
};
