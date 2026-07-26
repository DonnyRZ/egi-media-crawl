'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * SINDOnews (sindonews.com) adapter — Sprint 5 (S5-B). camelCase raw adapter, following the
 * same fixture-first pattern as `src/adapters/viva/index.js` / `src/adapters/tirto/index.js`.
 * `./coreAdapter.js` bridges this to the snake_case `ParsedArticle` shape `src/core`
 * (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct HTTP fetches,
 * plain `User-Agent: EGIMediaCrawler/0.1`, no blocking observed):
 *
 *  - **Multi-subdomain, ONE `source_id`.** Unlike detik (any subdomain accepted) or
 *    liputan6/viva/tirto (bare host only), SINDOnews genuinely ships each "kanal" (vertical) on
 *    its OWN subdomain, verified live from `https://www.sindonews.com/indeks`'s kanal `<select>`
 *    and its listing items' actual article hrefs:
 *      nasional.sindonews.com   (cid=5,  "Nasional")
 *      daerah.sindonews.com     (cid=7,  "Daerah")
 *      ekbis.sindonews.com      (cid=8,  "Ekonomi Bisnis")
 *      international.sindonews.com (cid=9, "International")
 *      sports.sindonews.com     (cid=10, "Sports")
 *      kalam.sindonews.com      (cid=67, "Kalam")
 *      edukasi.sindonews.com    (cid=144, "Edukasi")
 *      lifestyle.sindonews.com  (cid=154, "Lifestyle")
 *      otomotif.sindonews.com   (cid=611, "Otomotif")
 *      tekno.sindonews.com      (cid=612, "Teknologi")
 *    plus the bare `www.sindonews.com` itself (home/indeks/topic/blog pages, and per the task
 *    brief kept in `allowed_domains` as a first-class host even though no live article sample
 *    was observed served directly from `www`). ALL of these share the exact same template
 *    (`.detail-title`/`.detail-desc`/JSON-LD `NewsArticle`) — verified by sampling one article
 *    on `ekbis.` and one on `international.` — so a single `source_id: "sindonews"` /
 *    `adapter_version` covers every kanal; there is deliberately NO per-kanal adapter/source
 *    row (per task brief: "One source_id for entire brand — NOT per-kanal").
 *  - **Explicitly OUT of scope** (verified live): `e.sindonews.com` (static asset/logo CDN),
 *    `pict.sindonews.com` (article image CDN, appears in `og:image`/JSON-LD `image.url` on
 *    every sampled article) — neither ever serves an actual `/read/` article page, they are
 *    pure asset hosts. Also excluded (different template/product family, not part of the
 *    `/indeks` kanal `<select>` taxonomy at all, same "sibling vertical" treatment tirto gives
 *    `diajeng.id` / liputan6 gives `enamplus.liputan6.com`): `hi-lite.sindonews.com` ("Today's
 *    HI-LITE", a separate interactive/scrollytelling product — verified live it DOES have its
 *    own `/read/`-shaped URLs, which is exactly why it needs an explicit exclusion rather than
 *    relying on path shape alone), `scope.sindonews.com` ("SINDOscope"), `media.sindonews.com`
 *    (multimedia/TV/radio hub, links out to `media.sindonews.com/tv/rcti` etc — a DIFFERENT
 *    MNC-group product, not a SINDOnews news kanal), and `index.sindonews.com` (verified live:
 *    HTTP 301-redirects straight to `www.sindonews.com/indeks`, so it is a discovery ENTRY
 *    POINT alias, never an article host, and is never itself treated as in-scope by
 *    `isArticleUrl()`). Sibling MNC-group news brands reachable from SINDOnews's own nav
 *    ("MNC Networks" footer links to `rctiplus.com`, `visionplus.id`, etc — none of those are
 *    even `*.sindonews.com`) are rejected simply by the host allowlist, same as every other
 *    "reject sibling brand" adapter in this repo.
 *  - **Discovery**: `https://www.sindonews.com/indeks/{cid}/{offset}` (optionally `?t=
 *    YYYY-MM-DD` to pick a date, matching the site's own `#form-tanggal`-equivalent date
 *    picker) — verified live: `cid=0` means "Semua Kanal" (all kanal merged into one feed,
 *    used as the default discovery source since it naturally surfaces every subdomain without
 *    needing 10 separate per-kanal fetches), `cid` values above are the OTHER real per-kanal
 *    ids from the `<select>` (usable via `ctx.cid` to scope discovery to one vertical).
 *    `{offset}` is a CodeIgniter-style pagination offset, STEP +20 per page (verified live:
 *    the page-1 "next page" link is `/indeks/0/20?t=...`, and the "jump ahead" link the site's
 *    own pager renders is `/indeks/0/80?t=...`, i.e. page 5 = offset 80 = 4 * 20) — `offset=0`
 *    is page 1 (equivalent to the bare `/indeks` landing page). `index.sindonews.com` 301s to
 *    `www.sindonews.com/indeks` (see above) so this adapter always builds URLs against `www`
 *    directly rather than depending on that redirect.
 *  - **Article URL shape**: `https://{kanal}.sindonews.com/read/{id}/{subId}/{slug}[-{ts}]`
 *    e.g. `https://ekbis.sindonews.com/read/1731775/178/ihsg-sesi-siang-terjun-bebas-175-ke-
 *    6204-transaksi-tembus-rp104-triliun-1784873276`. `{id}` (first numeric segment right
 *    after `/read/`) is the STABLE numeric article id — this is `external_article_id`, and per
 *    the task brief is the PRIMARY dedupe key across kanal/subdomains (a republish under a
 *    different kanal subdomain, if it ever happens, would still be recognized as the same
 *    `{id}`). `{subId}` is a topic/rubric id (NOT part of the article identity — verified live
 *    it varies per-article even within the same kanal, e.g. `178` = "bursa finansial" sub-desk
 *    inside `ekbis`), and the trailing `-{ts}`-looking suffix on the slug is not a second id
 *    either, just part of the slug.
 *  - **Pagination path segments are NOT ids**: verified live that a paginated article's page 2
 *    is served at the SAME `/read/{id}/{subId}/{slug}` path with an extra trailing numeric
 *    segment appended — e.g. `.../ihsg-...-1784873276/5` for one article and `.../doa-doa-...-
 *    1768539674/10` for another. The task brief calls this out explicitly ("`/5`, `/10` path
 *    segments are page offsets, not IDs") because they are easy to misparse as a second
 *    article id; this adapter's `EXTERNAL_ID_PATTERN` only ever looks at the FIRST numeric
 *    segment after `/read/`, so it is immune to this either way, and `isArticleUrl()`/
 *    `stripPageParam()` both explicitly recognize (and strip) this trailing segment rather than
 *    ignoring it.
 *  - **Parse**: article page 1 ships a full `NewsArticle` JSON-LD block (headline/dates/
 *    author/image/description) PLUS a `BreadcrumbList` JSON-LD (2 items: "home" + one
 *    category, e.g. "bursa finansial" — used as `category`, no URL-segment fallback needed
 *    since the breadcrumb is always present). Title/author/date are ALSO independently
 *    server-rendered in the DOM (`h1.detail-title`, `.detail-nama-redaksi a[rel="author"]`,
 *    `.detail-date-artikel` — a non-ISO Indonesian string, "Jum'at, 24 Juli 2026 - 13:39 WIB"),
 *    used only as a fallback if JSON-LD is ever missing.
 *  - **CRITICAL — multipage prefers `?showpage=all`**: verified live that EVERY sampled
 *    article (even short ones) reports `total_page: '2'` in an inline analytics `<script>` and
 *    renders a `.paging-artikel` widget with a page-2 link (the `/5` / `/10` trailing-segment
 *    URL above) AND a `.paging-all a[href*="showpage=all"]` "Baca Selengkapnya" link that
 *    appends `?showpage=all` to the (unsuffixed) canonical URL. Verified live that:
 *      (a) the canonical `<link rel="canonical">` tag on every page variant (page 1, page 2,
 *          and `?showpage=all`) always points at the bare, unsuffixed page-1 URL — never the
 *          `/5`-suffixed or `?showpage=all` variant — so `canonical_url` is always stable
 *          regardless of which variant was fetched;
 *      (b) page 2+ (the `/5`-suffixed URL) and the `?showpage=all` URL BOTH carry only
 *          `BreadcrumbList`/`WebSite`/`NewsMediaOrganization`/`ItemList` JSON-LD — the
 *          `NewsArticle` block (title/dates/author/image/description) is ONLY present on the
 *          unsuffixed page-1 URL. This matches the task brief's "page 2+ often lack JSON-LD"
 *          note exactly.
 *      (c) `?showpage=all` merges every page's body text into ONE `.detail-desc`/`#detail-desc`
 *          element (verified live: the page-1-only body is a strict prefix of the
 *          `?showpage=all` body for the same article) — so this adapter fetches page 1 for
 *          metadata (JSON-LD/DOM), and additionally fetches `?showpage=all` (live) / a bundled
 *          second fixture (offline) purely for the complete body text, exactly per the task
 *          brief's "multipage prefer `?showpage=all`" guidance. If that second fetch is
 *          unavailable for any reason, `parse()` degrades gracefully to the page-1-only body
 *          (better a short article than a hard failure).
 *  - **Body markup has NO `<p>` tags**: verified live, `.detail-desc`/`#detail-desc` (same
 *    element carries both the id and the class) is a flat run of text + inline `<a class=
 *    "int-link">`/`<strong>` nodes separated by one-or-more `<br>` tags — there is no `<p>`
 *    wrapper to select the way every other adapter in this repo does. `extractParagraphs()`
 *    below collapses runs of `<br>` into paragraph boundaries instead. Inline "Baca Juga:
 *    <a>...</a>" recirculation prompts (verified live: NOT wrapped in their own container div,
 *    just plain inline text immediately after/around a `<br><br>` boundary) collapse into their
 *    own paragraph-shaped segment this way and are filtered by a leading-text match. A trailing
 *    `<div class="editor">(initials)</div>` desk sign-off and any `<div class="v-youtube">`
 *    (or other `[class^="v-"]`) embedded-video wrapper are stripped before the `<br>` split.
 *  - `summary` <- JSON-LD `description` > `og:description` > `meta[name=description]`.
 *  - `thumbnailUrl` <- JSON-LD `image.url` > `og:image`.
 *  - `tags` <- `meta[name="keywords"]` (comma-separated; verified live populated, e.g. "sesi
 *    ihsg,ihsg,ihsg hari ini,pergerakan ihsg,bursa saham" — no taxonomy-label noise observed
 *    the way tirto's `news_keywords` has, so no stopword filtering is applied here).
 *
 * SAFETY: `discover()`'s live `/indeks` fetch and `parse()`'s extra `?showpage=all` fetch both
 * only run when `process.env.CRAWL_LIVE === 'true'` (same convention as `src/workers/lib/
 * fetchHtml.js` / every other adapter in this repo) — otherwise both read the bundled
 * `fixtures/sindonews/*` fixtures, so simply registering this adapter never causes surprise
 * network traffic.
 */

const SOURCE_ID = 'sindonews';
const BASE_URL = 'https://www.sindonews.com/';
const INDEKS_BASE_URL = 'https://www.sindonews.com/indeks';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'sindonews');
const FIXTURE_INDEKS_PATH = path.join(FIXTURES_DIR, 'indeks.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');
const FIXTURE_ARTICLE_SHOWPAGE_ALL_PATH = path.join(FIXTURES_DIR, 'sample-article-showpage-all.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8;
const INDEKS_PAGE_STEP = 20; // verified live CodeIgniter-style pagination offset step

// Real "kanal" (vertical) subdomains, gathered live from the `/indeks` kanal `<select>`
// (value -> cid) cross-checked against actual article hrefs seen in the listing. `www` is
// included per the task brief ("allowed_domains: allowlist of news kanal hosts +
// www.sindonews.com") even though no live article sample was observed served directly from
// it. Deliberately EXCLUDES `e.`/`pict.` (asset/CDN hosts) and `hi-lite.`/`scope.`/`media.`
// (separate MNC-group products, not part of this kanal taxonomy) — see module header.
const KANAL_HOSTS = {
  nasional: 5,
  daerah: 7,
  ekbis: 8,
  international: 9,
  sports: 10,
  kalam: 67,
  edukasi: 144,
  lifestyle: 154,
  otomotif: 611,
  tekno: 612,
};

const ALLOWED_ARTICLE_HOSTS = new Set([
  'www.sindonews.com',
  ...Object.keys(KANAL_HOSTS).map((kanal) => `${kanal}.sindonews.com`),
]);

// `/read/{id}/{subId}/{slug}` optionally followed by ONE extra numeric path segment (the
// pagination offset for page 2+, e.g. "/5", "/10" — see module header, NOT a second id) and/or
// a query string (e.g. "?showpage=all"). Host is checked separately via ALLOWED_ARTICLE_HOSTS
// (exact hostname match, not a substring/regex check) so sibling brands and asset/CDN hosts
// can never slip through even if linked directly from a SINDOnews page.
const ARTICLE_PATH_PATTERN = /^\/read\/(\d+)\/\d+\/[a-z0-9-]+(?:\/\d+)?\/?$/i;

const EXTERNAL_ID_PATTERN = /^\/read\/(\d+)\//i;

// Stripped from a clone of `.detail-desc` before the `<br>` paragraph split (see module header
// "Body markup has NO <p> tags"): embedded video/social widgets (`[class^="v-"]`, e.g.
// `.v-youtube`), the trailing desk-initials sign-off, ad scaffolding, and inline scripts.
const BODY_NOISE_SELECTORS = [
  'script',
  'style',
  'ins',
  'iframe',
  '[class^="v-"]',
  '.editor',
  '[id^="ads_"]',
  '.adsbygoogle',
  'figcaption',
];

// A paragraph-shaped segment consisting ONLY of a "Baca Juga" recirculation prompt (verified
// live: inline text immediately around a <br> boundary, not wrapped in its own container div —
// see module header). Matched after trimming so it also catches the colon-less "Baca Juga
// <title>" variant seen live.
const BACA_JUGA_PATTERN = /^Baca Juga\s*:?\s*/i;

// Indonesian full month names, for the DOM `.detail-date-artikel` fallback ("Jum'at, 24 Juli
// 2026 - 13:39 WIB" — verified live format). JSON-LD `datePublished` is the primary source and
// already carries an explicit `+07:00` offset, so this fallback path is rarely exercised.
const MONTH_INDEX = {
  januari: 0,
  februari: 1,
  maret: 2,
  april: 3,
  mei: 4,
  juni: 5,
  juli: 6,
  agustus: 7,
  september: 8,
  oktober: 9,
  november: 10,
  desember: 11,
};

// Fixture "listing" used by discover() when live discovery isn't requested. Deliberately
// spans multiple kanal subdomains (ekbis + international + nasional) so an offline smoke test
// can already exercise the "one source_id, many hosts" contract without CRAWL_LIVE.
const FIXTURE_LISTING = [
  {
    rawUrl: 'https://ekbis.sindonews.com/read/1900001/178/contoh-berita-ekbis-pertama-sindonews-1900000001',
    listingTitle: 'Contoh Berita Ekbis Pertama SINDOnews',
    publishedHint: "Jum'at, 24 Juli 2026 - 14:00 WIB",
    categoryHint: 'Ekonomi Bisnis',
  },
  {
    rawUrl: 'https://international.sindonews.com/read/1900002/41/contoh-berita-internasional-sindonews-1900000002',
    listingTitle: 'Contoh Berita Internasional SINDOnews',
    publishedHint: "Jum'at, 24 Juli 2026 - 13:45 WIB",
    categoryHint: 'International',
  },
  {
    rawUrl: 'https://nasional.sindonews.com/read/1900003/14/contoh-berita-nasional-sindonews-1900000003',
    listingTitle: 'Contoh Berita Nasional SINDOnews',
    publishedHint: "Jum'at, 24 Juli 2026 - 13:30 WIB",
    categoryHint: 'Nasional',
  },
];

function isLiveCrawlEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function readFixtureSafe(fixturePath) {
  try {
    return readFixture(fixturePath);
  } catch {
    return undefined;
  }
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'SINDOnews',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 20,
    overlapHours: 3,
    enabled: true,
  };
}

/**
 * @param {string} url
 * @returns {boolean} true iff `url` is a `/read/{id}/{subId}/{slug}` article on one of the
 *   allowlisted SINDOnews kanal hosts (or `www`) — see `ALLOWED_ARTICLE_HOSTS`/module header.
 *   Explicitly false for asset hosts (`e.`/`pict.`), out-of-scope MNC-group products
 *   (`hi-lite.`/`scope.`/`media.`), and any sibling/non-sindonews.com brand.
 */
function isArticleUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_ARTICLE_HOSTS.has(host)) {
    return false;
  }
  return ARTICLE_PATH_PATTERN.test(parsed.pathname);
}

/**
 * Strips the pagination trailing path segment (e.g. "/5", "/10" — see module header, NOT an
 * id) and any query string (e.g. "?showpage=all") so every page-variant of an article
 * collapses to the same canonical identity, mirroring the `stripPageParam()` invariant every
 * other adapter in this repo defends (there, `page` is a query param instead of a path
 * segment, since SINDOnews's own pagination is path-based).
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function stripPageParam(url) {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return url;
  }
  parsed.search = '';
  const match = /^(\/read\/\d+\/\d+\/[a-z0-9-]+)(?:\/\d+)?\/?$/i.exec(parsed.pathname);
  if (match) {
    parsed.pathname = match[1];
  }
  return parsed.toString();
}

/**
 * @param {string} canonicalUrl - already page-offset-stripped (see `stripPageParam`).
 * @returns {string}
 */
function buildShowpageAllUrl(canonicalUrl) {
  try {
    const parsed = new URL(canonicalUrl);
    parsed.searchParams.set('showpage', 'all');
    return parsed.toString();
  } catch (_err) {
    return `${canonicalUrl}${canonicalUrl.includes('?') ? '&' : '?'}showpage=all`;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the FIRST numeric segment after `/read/` — the stable article
 *   id, used as `external_article_id` (primary dedupe key across kanal/subdomains per the task
 *   brief). Deliberately ignores any trailing pagination segment (see module header).
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const { pathname } = new URL(url);
    const match = EXTERNAL_ID_PATTERN.exec(pathname);
    return match ? match[1] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the kanal subdomain label (e.g. "ekbis"), used only as a
 *   discovery-time category hint — the authoritative `category` on the parsed article comes
 *   from the JSON-LD `BreadcrumbList` (see module header).
 */
function extractKanalHint(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const kanal = host.split('.')[0];
    return Object.prototype.hasOwnProperty.call(KANAL_HOSTS, kanal) ? kanal : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {{cid?: number|string, offset?: number|string, date?: string}} [opts] - `cid=0`
 *   ("Semua Kanal") and `offset=0` (page 1) are the defaults, matching the bare `/indeks`
 *   landing page. `date` is the site's own `?t=YYYY-MM-DD` filter.
 * @returns {string}
 */
function buildIndeksUrl({ cid = 0, offset = 0, date } = {}) {
  const url = new URL(`${INDEKS_BASE_URL}/${cid}/${offset}`);
  if (date) {
    url.searchParams.set('t', date);
  }
  return url.toString();
}

/**
 * Parses an `/indeks` listing page into discovery entries. Each entry is a `.warp-article`
 * (verified live 2026-07-24) with an image-wrapping anchor, a `.sub-kanal a` (kanal name +
 * link, used only as a category hint), a `.title-article a[href]` (title + link — the
 * canonical discovery link), and a `.date-article` (non-ISO Indonesian date string).
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function extractIndeksItems(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('.warp-article').each((_, el) => {
    if (items.length >= limit) return;
    const $item = $(el);
    const $titleLink = $item.find('.title-article a[href]').first();
    const href = $titleLink.attr('href') || $item.find('a[href]').first().attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    items.push({
      rawUrl: href,
      listingTitle: $titleLink.text().trim() || undefined,
      publishedHint: $item.find('.date-article').first().text().trim() || undefined,
      categoryHint: $item.find('.sub-kanal a').first().text().trim() || extractKanalHint(href),
      externalId: extractExternalId(href),
    });
  });

  return items;
}

/**
 * @param {{cid?: number|string, offset?: number|string, date?: string, limit?: number,
 *   logger?: {warn?: Function}}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx = {}) {
  const limit = Number.isInteger(ctx && ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const indeksUrl = buildIndeksUrl({ cid: ctx.cid, offset: ctx.offset, date: ctx.date });

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
 * @param {{cid?, offset?, date?, limit?, liveDiscover?: boolean, logger?}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx && ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;

  if (isLiveCrawlEnabled(ctx)) {
    try {
      const live = await discoverLive(ctx);
      if (live.items.length > 0) {
        return live;
      }
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('[sindonews] discover(): live /indeks fetch returned 0 matching article URL(s); falling back to fixture listing');
      }
    } catch (err) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`[sindonews] discover(): live /indeks fetch failed (${err.message}); falling back to fixture listing`);
      }
    }
  }

  const fixtureItems = extractIndeksItems(readFixture(FIXTURE_INDEKS_PATH), limit);
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

function findBreadcrumbLd(blocks) {
  return blocks.find((block) => block && block['@type'] === 'BreadcrumbList');
}

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {object|undefined} breadcrumbLd
 * @returns {string|undefined} the most specific (last) breadcrumb item name, e.g.
 *   "bursa finansial" — verified live SINDOnews breadcrumbs are always exactly 2 items
 *   ("home" + one category), so "last" and "most specific" are equivalent here.
 */
function extractCategoryFromBreadcrumb(breadcrumbLd) {
  const items = breadcrumbLd && Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  if (items.length === 0) return undefined;
  const last = items[items.length - 1];
  const name = last && last.item && last.item.name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

/**
 * @param {string} text - e.g. "Jum'at, 24 Juli 2026 - 13:39 WIB".
 * @returns {string|undefined} ISO 8601 string (assumes `WIB` => `+07:00`), or undefined if the
 *   text doesn't contain a recognizable "DD MonthName YYYY - HH:mm" fragment.
 */
function parseIndonesianDateTime(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*-\s*(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function extractAuthorName($) {
  const domAuthor = $('.detail-nama-redaksi a[rel="author"]').first().text().trim();
  return domAuthor || undefined;
}

/**
 * Collapses runs of `<br>` tags inside a (already-noise-stripped) clone of `.detail-desc` into
 * paragraph boundaries (see module header "Body markup has NO <p> tags"), then filters out any
 * resulting segment that is purely a "Baca Juga" recirculation prompt.
 * @param {cheerio.Cheerio} bodyEl
 * @returns {string[]}
 */
function extractParagraphs(bodyEl) {
  if (!bodyEl || bodyEl.length === 0) return [];

  const cleaned = bodyEl.clone();
  cleaned.find(BODY_NOISE_SELECTORS.join(', ')).remove();

  const rawHtml = cleaned.html() || '';
  const segments = rawHtml.split(/(?:\s*<br\s*\/?>\s*)+/gi);

  return segments
    .map((segment) => cheerio.load(`<div>${segment}</div>`)('div').first().text().trim())
    .filter((text) => text.length > 0)
    .filter((text) => !BACA_JUGA_PATTERN.test(text));
}

/**
 * Live-mode helper: fetches the `?showpage=all` variant of an article for the complete,
 * multipage-merged body text (see module header "multipage prefers `?showpage=all`"). Never
 * throws — any failure just means `parse()` falls back to the page-1-only body.
 * @param {string} showpageAllUrl
 * @returns {Promise<string|undefined>}
 */
async function fetchShowpageAll(showpageAllUrl) {
  try {
    const response = await axios.get(showpageAllUrl, {
      headers: { 'User-Agent': CRAWLER_UA },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
      responseType: 'text',
    });
    if (response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
      return response.data;
    }
  } catch (_err) {
    // non-fatal, see doc comment
  }
  return undefined;
}

/**
 * Resolves the HTML to use for the article BODY (paragraphs), preferring `?showpage=all` per
 * the task brief. Resolution order:
 *   1. `ctx.fetchShowpageAll(url)` — injected by tests/callers (offline-safe).
 *   2. The bundled `?showpage=all` fixture, IF `firstPageHtml` itself came from the bundled
 *      page-1 fixture (keeps offline smoke testing working out of the box).
 *   3. Live HTTP via axios, IF `CRAWL_LIVE=true`.
 *   4. Otherwise: `firstPageHtml` itself (best-effort single-page body, matches how `parse()`
 *      already degrades gracefully elsewhere in this codebase).
 * @param {string} firstPageHtml
 * @param {string|undefined} canonicalUrl
 * @param {import('../_template').AdapterContext} [ctx]
 * @returns {Promise<{html: string, usedShowpageAll: boolean}>}
 */
async function resolveBodyHtml(firstPageHtml, canonicalUrl, ctx) {
  const isFixtureFirstPage = firstPageHtml === readFixtureSafe(FIXTURE_ARTICLE_PATH);
  const fetchShowpageAllFn = (ctx && typeof ctx.fetchShowpageAll === 'function' && ctx.fetchShowpageAll) || undefined;

  let mergedHtml;
  try {
    if (fetchShowpageAllFn) {
      mergedHtml = await fetchShowpageAllFn(canonicalUrl ? buildShowpageAllUrl(canonicalUrl) : undefined);
    } else if (isFixtureFirstPage) {
      mergedHtml = readFixtureSafe(FIXTURE_ARTICLE_SHOWPAGE_ALL_PATH);
    } else if (canonicalUrl && isLiveCrawlEnabled(ctx)) {
      mergedHtml = await fetchShowpageAll(buildShowpageAllUrl(canonicalUrl));
    }
  } catch (_err) {
    mergedHtml = undefined;
  }

  return mergedHtml ? { html: mergedHtml, usedShowpageAll: true } : { html: firstPageHtml, usedShowpageAll: false };
}

/**
 * @param {import('../_template').AdapterContext} [ctx]
 * @returns {string}
 */
function resolveFirstPageHtml(html) {
  return typeof html === 'string' && html.length > 0 ? html : readFixture(FIXTURE_ARTICLE_PATH);
}

async function parse(html, ctx) {
  const firstPageHtml = resolveFirstPageHtml(html);
  const $ = cheerio.load(firstPageHtml);

  const ldBlocks = extractJsonLd($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};
  const breadcrumbLd = findBreadcrumbLd(ldBlocks);

  const canonicalUrlRaw =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && articleLd.mainEntityOfPage['@id']) ||
    (ctx && ctx.url);
  const canonicalUrl = canonicalUrlRaw ? stripPageParam(canonicalUrlRaw) : undefined;

  const url = (ctx && ctx.url) || canonicalUrl;

  const title =
    articleLd.headline ||
    $('h1.detail-title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author = (articleLd.author && articleLd.author.name) || extractAuthorName($);

  const publishedAt =
    toIsoOrUndefined(articleLd.datePublished) || parseIndonesianDateTime($('.detail-date-artikel').first().text().trim());

  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const summary =
    articleLd.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const ldImage = articleLd.image;
  const thumbnailUrl =
    (ldImage && (typeof ldImage === 'string' ? ldImage : ldImage.url)) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const category = extractCategoryFromBreadcrumb(breadcrumbLd);

  const keywordsContent = $('meta[name="keywords"]').attr('content') || '';
  const tags = keywordsContent
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const externalArticleId = extractExternalId(canonicalUrl || url || '');

  const { html: bodyHtml, usedShowpageAll } = await resolveBodyHtml(firstPageHtml, canonicalUrl, ctx);
  const $body = bodyHtml === firstPageHtml ? $ : cheerio.load(bodyHtml);
  const bodyEl = $body('.detail-desc').first().length ? $body('.detail-desc').first() : $body('#detail-desc').first();
  const paragraphs = extractParagraphs(bodyEl);

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
    usedShowpageAll,
    rawHtml: firstPageHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/sindonews/smoke-test.js) and for
  // debugging extraction logic in isolation.
  buildIndeksUrl,
  buildShowpageAllUrl,
  extractIndeksItems,
  extractExternalId,
  extractKanalHint,
  extractCategoryFromBreadcrumb,
  extractParagraphs,
  parseIndonesianDateTime,
  stripPageParam,
  discoverLive,
  isLiveCrawlEnabled,
  KANAL_HOSTS,
  ALLOWED_ARTICLE_HOSTS,
  FIXTURE_INDEKS_PATH,
  FIXTURE_ARTICLE_PATH,
  FIXTURE_ARTICLE_SHOWPAGE_ALL_PATH,
};
