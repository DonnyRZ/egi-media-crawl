'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * IDN Times (www.idntimes.com) adapter — Sprint 6a (S6a-A). camelCase raw adapter, following
 * the same fixture-first pattern as `src/adapters/tirto/index.js` / `src/adapters/okezone/
 * index.js` / `src/adapters/sindonews/index.js`. `./coreAdapter.js` bridges this to the
 * snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct HTTP fetches —
 * PowerShell `Invoke-WebRequest` with a desktop-browser User-Agent, against `www.idntimes.com`
 * directly and its own live `robots.txt`):
 *
 *  - **Host scope is `www.idntimes.com` only** (per task brief) — NOT a `*.idntimes.com`
 *    wildcard. IDN Times runs many "hyperlocal" regional subdomains on the same brand
 *    (`bali.idntimes.com`, `jatim.idntimes.com`, etc. — verified live, surfaced inline as a
 *    "Regional" widget on `www.idntimes.com/news` itself) which are a DIFFERENT template/
 *    content pool entirely and are out of scope here, same treatment `tirto/index.js` gives
 *    `diajeng.id` or `okezone/index.js` gives sibling MNC brands off its own apex.
 *  - **`/indeks` 404s live** (per task brief, confirmed) — discovery instead uses top-level
 *    category hub paths (`/news`, `/tech`, `/sport`, ... — verified live 200 OK on `/news`),
 *    which double as a robots-compliant, query-string-free listing page. `ctx.channelUrl` (or
 *    `ctx.category`) can override which hub is fetched; `discover()` defaults to `/news`.
 *  - **robots.txt** (fetched live): `Disallow: /?*`, `/*?utm*`, `/search?*`, `/tag-manager*`,
 *    `/v1`, `/ajax/`. None of these match a bare category hub path like `/news` (no query
 *    string at all), so that stays fully robots-compliant. Per task brief, `/index?page=N`-
 *    style pagination is treated as robots-AMBIGUOUS here (a permissive reading of `/?*` only
 *    matches a literal `/?...` right at the domain root, but a stricter/more common
 *    interpretation some robots-checkers apply is "any URL with a query string") — this
 *    adapter deliberately never constructs or fetches ANY `?`-bearing URL of its own for
 *    discovery, erring conservative. **Residual/documented limitation**: this means
 *    `discover()` only ever sees ONE hub page's worth of items (~20-30 live, verified) with NO
 *    pagination — deeper backfill would need `https://www.idntimes.com/sitemap.xml` (present,
 *    verified live, advertised in robots.txt) as a separate discovery channel, which is
 *    explicitly OUT OF SCOPE for this sprint (not implemented) and left for a future agent.
 *    `api-mono.idn.media` (needs an API key) is likewise out of scope per task brief.
 *  - **Article URL shape** (verified live across many samples, every top-level category):
 *      `https://www.idntimes.com/{category}/{subcategory}/{slug-words...}-{authorCode5}-{articleCode6}`
 *    e.g. `.../news/indonesia/febrie-adriansyah-penuhi-panggilan-kejagung-diperiksa-jadi-saksi-tppu-00-vdzm7-nxxvry`,
 *    `.../sport/soccer/spanyol-juara-piala-dunia-2026-usai-kalahkan-argentina-00-f411s-1ns3l3`.
 *    Always EXACTLY 3 path segments; the slug's trailing two hyphen-separated tokens are a
 *    stable-width pair — a 5-character `authorCode` then a 6-character `articleCode` (both
 *    lowercase alphanumeric, verified live across every sampled category) — with an arbitrary
 *    number of extra tokens (title words, and sometimes an extra "variant" marker like `00`,
 *    `01`, or `c1c2-01`) before that pair. `ARTICLE_PATH_PATTERN` requires exactly 3 segments
 *    and that trailing `-{5}-{6}` shape on the last one; `NON_ARTICLE_FIRST_SEGMENTS` rejects
 *    a few known 1-2 segment utility roots defensively even though the segment-count check
 *    alone already excludes them (`/author/{slug}`, `/tag/{slug}`, `/search`, `/ajax/...`,
 *    `/v1`, `/tag-manager...`).
 *  - **`external_article_id` is `{authorCode}-{articleCode}` (BOTH tokens), not just the
 *    6-char `articleCode` alone**: verified live that the 6-char `articleCode` alone can
 *    collide — two different live-indexed URLs for what is evidently the same underlying
 *    article (`/sport/soccer/spanyol-juara-piala-dunia-2026-usai-kalahkan-argentina-00-f411s-1ns3l3`
 *    vs `...-00-dtjm6-1ns3l3`, identical title/slug, DIFFERENT `authorCode`, SAME
 *    `articleCode` "1ns3l3") were both found indexed — so the combined pair is used to keep
 *    `external_article_id` collision-resistant.
 *  - Article page is JSON-LD-strong: a `NewsArticle` block (verified live) carries `headline`,
 *    `author` (array of `{name, url}`), `datePublished`/`dateModified` (BOTH with an explicit
 *    `+07:00` offset already — no "assume WIB" guesswork needed, unlike okezone/tirto),
 *    `image.url`, `keywords` (array — real per-article tags), and (verified live on both
 *    sampled articles) a non-empty `articleBody` STRING with paragraph boundaries already
 *    stripped out (sentences run together with no separator) — used here only as a last-
 *    resort content fallback since it can't be split back into real paragraphs. A separate
 *    `WebPage` JSON-LD block carries `breadcrumb.itemListElement` (`Home` > `News` >
 *    `Indonesia`, etc.) — the category source (last non-"Home" item).
 *  - **`keywords` can contain a junk/placeholder entry**: verified live on one real sample,
 *    `keywords` included the literal string `"Update me"` alongside genuine topical keywords
 *    — `KEYWORD_STOPWORDS` filters this (case-insensitively) out of `tags`.
 *  - **`NewsArticle.description` is sometimes an empty string** (verified live — one sampled
 *    article had `"description":""`; another had a real one-sentence synopsis). When empty,
 *    `summary` falls back to `og:description`/`meta[name=description]`, which on that same
 *    empty-description article were ALSO verified live to just duplicate the headline
 *    verbatim (not a real synopsis) — so `summary` is low-information (but never absent) for
 *    such articles; kept as a documented caveat in `coreAdapter.js`'s field matrix rather than
 *    treated as an error.
 *  - Body text lives in DOM `#article-description p.article-text` (verified live exact `id`/
 *    class pair on both sampled articles; no ad/"Baca juga" noise observed inside it on either
 *    sample, so no body-noise stripping selectors were needed here unlike detik/CNN/okezone —
 *    documented as an assumption that may need revisiting once more live samples are seen).
 *    In-body `<a data-x-link-type="internal">` tag-mention links are kept as plain text (cheerio
 *    `.text()` already flattens them) so they never corrupt paragraph boundaries.
 *  - **No multipage markup was found on either sampled live article** (no page-N widget/link)
 *    — every article ships as a single HTML document, so `parse()` never performs extra
 *    network I/O for pagination.
 *  - Listing (category hub) cards: verified live on `/news`, each real card's title is an
 *    `<h2 data-cy="ds-card-article-title">` wrapped in an `<a href="...">`; the publish-date
 *    (`[data-cy="ds-card-article-pubdate"]`, format `"D MMM YYYY, HH:mm WIB"`, English 3-
 *    letter month abbreviations observed live e.g. "Jul") and category label (`[data-cy=
 *    "ds-card-article-category"]`) are SIBLINGS of that `<a>` in a shared container div, not
 *    descendants of it — `extractListingItems()` walks up to `$anchor.parent()` to read them.
 *    A non-article "Regional" hyperlocal promo widget (`data-cy="ds-widget-card-*"`, its own
 *    distinct `data-testid="ds-widget-card-title"`) and empty ad slots (`id="headline-ads-*"`)
 *    are naturally excluded since the card selector is scoped to `ds-card-article-title`
 *    specifically (verified live both are present on the real `/news` page).
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every sibling adapter); otherwise it
 * returns the bundled fixture listing. `parse()` is fixture-first when no `html` is supplied
 * (or `ctx.fixtureOnly` is set), reading `fixtures/idn_times/sample-article.html`. Registered
 * into `src/adapters/index.js`'s ADAPTER_MODULES map by S6a-D.
 */

const SOURCE_ID = 'idn_times';
const BASE_URL = 'https://www.idntimes.com/';
const ALLOWED_HOST = 'www.idntimes.com';
const DEFAULT_CATEGORY = 'news';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'idn_times');
const FIXTURE_LISTING_PATH = path.join(FIXTURES_DIR, 'listing-news.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range

// Article URLs: https://www.idntimes.com/{category}/{subcategory}/{slug-words...}-{authorCode5}-{articleCode6}
// Host is pinned to ALLOWED_HOST on purpose (see module header "Host scope"). Exactly 3 path
// segments are required; the last segment must end in a 5-char then 6-char lowercase
// alphanumeric token pair (verified live stable width — see module header "Article URL shape").
const ARTICLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{5}-[a-z0-9]{6}$/i;

// Known non-article path roots (1-2 segments live) — defensive; the 3-segment + trailing-code
// requirement in isArticleUrl() already excludes these on shape alone, but listed here for
// clarity/robustness and to mirror the sibling adapters' style (e.g. tirto's
// NON_ARTICLE_ROOT_SLUGS).
const NON_ARTICLE_FIRST_SEGMENTS = new Set(['author', 'tag', 'search', 'ajax', 'v1', 'tag-manager', 'sitemap.xml']);

// Verified live on one real `keywords` sample — a junk/placeholder entry mixed in with real
// topical keywords (see module header). Filtered case-insensitively out of `tags`.
const KEYWORD_STOPWORDS = new Set(['update me']);

// "D MMM YYYY, HH:mm WIB" as seen live on category hub listing cards (English 3-letter month
// abbreviations observed, e.g. "Jul") — Indonesian abbreviations mapped too defensively in
// case a different card template/locale uses them instead (same defensive stance as
// tirto/okezone's own month maps).
const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  mei: 4,
  may: 4,
  jun: 5,
  jul: 6,
  jly: 6,
  agu: 7,
  ags: 7,
  aug: 7,
  sep: 8,
  sept: 8,
  okt: 9,
  oct: 9,
  nov: 10,
  des: 11,
  dec: 11,
};

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'IDN Times',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 30,
    overlapHours: 4,
    enabled: true,
  };
}

/**
 * @param {string} url
 * @returns {boolean} true iff `url`'s hostname is exactly `www.idntimes.com` (case-
 *   insensitive) — deliberately NOT a `*.idntimes.com` wildcard, see module header "Host scope".
 */
function isInScope(url) {
  try {
    return new URL(url).hostname.toLowerCase() === ALLOWED_HOST;
  } catch (_err) {
    return false;
  }
}

function isArticleUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  if (!isInScope(url)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return false;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 3) {
    return false;
  }
  if (NON_ARTICLE_FIRST_SEGMENTS.has(segments[0].toLowerCase())) {
    return false;
  }
  return ARTICLE_SLUG_PATTERN.test(segments[2]);
}

/**
 * Strips `utm_*` tracking params defensively before using a URL as a normalized/canonical
 * identity — robots.txt disallows crawling `/*?utm*` variants outright (see module header), so
 * this never fetches such a URL, but a listing page can still surface one as an `href` (e.g.
 * shared/socially-tracked links); stripping keeps the normalized identity clean regardless.
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function stripTrackingParams(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch (_err) {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} `{authorCode}-{articleCode}` (5-char + 6-char lowercase
 *   alphanumeric tokens trailing the slug), used as `external_article_id`. See module header
 *   "external_article_id" note on why BOTH tokens are combined rather than just the 6-char one.
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const slug = segments[2] || '';
    const match = /-([a-z0-9]{5})-([a-z0-9]{6})$/i.exec(slug);
    return match ? `${match[1]}-${match[2]}` : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {{category?: string}} [opts]
 * @returns {string} `https://www.idntimes.com/{category}` — a bare, query-string-free category
 *   hub path (robots-compliant, see module header "Discovery"/"robots.txt" notes). Defaults to
 *   `news`.
 */
function buildCategoryUrl({ category = DEFAULT_CATEGORY } = {}) {
  return `${BASE_URL}${category}`;
}

/**
 * @param {string} text - e.g. "24 Jul 2026, 16:36 WIB" (verified live listing card format).
 * @returns {string|undefined} ISO 8601 string, assuming `+07:00` (WIB, no other tz ever seen
 *   on this site's listing cards).
 */
function parseListingDateTime(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Extracts up to `limit` unique in-scope article entries (in document order) from a category
 * hub listing page (`[data-cy="ds-card-article-title"]`, verified live on `/news` — see module
 * header "Listing (category hub) cards"). Shared by both the fixture and live discovery paths.
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function extractListingItems(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('a')
    .has('h2[data-cy="ds-card-article-title"]')
    .each((_, el) => {
      if (items.length >= limit) return;
      const $anchor = $(el);
      const href = $anchor.attr('href');
      if (!href || seen.has(href) || !isArticleUrl(href)) return;
      seen.add(href);

      const $container = $anchor.parent();
      items.push({
        rawUrl: href,
        listingTitle: $anchor.find('h2[data-cy="ds-card-article-title"]').first().text().trim() || undefined,
        publishedHint: parseListingDateTime($container.find('[data-cy="ds-card-article-pubdate"]').first().text().trim()),
        categoryHint: $container.find('[data-cy="ds-card-article-category"]').first().text().trim() || undefined,
        externalId: extractExternalId(href),
      });
    });

  return items.slice(0, limit);
}

/**
 * @param {{limit?: number, discoverLimit?: number, category?: string, channelUrl?: string, logger?: Object}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const hubUrl = (ctx && ctx.channelUrl) || buildCategoryUrl({ category: ctx && ctx.category });

  const response = await axios.get(hubUrl, {
    headers: { 'User-Agent': CRAWLER_UA },
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'text',
  });

  if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
    return { items: [] };
  }

  const entries = extractListingItems(response.data, limit);
  const items = entries.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: stripTrackingParams(entry.rawUrl),
    discoveryChannel: `category_hub:${(ctx && ctx.category) || DEFAULT_CATEGORY}`,
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    externalId: entry.externalId,
    categoryHint: entry.categoryHint,
  }));

  return { items };
}

async function discover(ctx) {
  if (isLiveDiscoverEnabled(ctx)) {
    try {
      const live = await discoverLive(ctx);
      if (live.items.length > 0) {
        return live;
      }
    } catch (err) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`idn_times discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const fixtureHtml = readFixture(FIXTURE_LISTING_PATH);
  const entries = extractListingItems(fixtureHtml, limit);
  const items = entries.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: stripTrackingParams(entry.rawUrl),
    discoveryChannel: 'fixture',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    externalId: entry.externalId,
    categoryHint: entry.categoryHint,
  }));

  return { items };
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

function extractJsonLdBlocks($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    blocks.push(...parseJsonLdBlock($, el));
  });
  return blocks;
}

function findByType(blocks, typeName) {
  return blocks.find((block) => {
    const type = block && block['@type'];
    if (!type) return false;
    const types = Array.isArray(type) ? type : [type];
    return types.includes(typeName);
  });
}

/**
 * @param {string|undefined} value - already-tz'd ISO-ish string (verified live both
 *   `datePublished`/`dateModified` always carry an explicit `+07:00` offset — see module
 *   header). No "assume WIB" fallback needed, unlike okezone/tirto.
 * @returns {string|undefined}
 */
function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {Object|undefined} webPageLd - `WebPage` JSON-LD block, whose `breadcrumb.
 *   itemListElement` (verified live) carries `Home` > `{Channel}` > `{Subcategory}`.
 * @returns {string|undefined} the most specific (last) non-"Home" item name.
 */
function extractCategoryFromBreadcrumbLd(webPageLd) {
  const items =
    webPageLd && webPageLd.breadcrumb && Array.isArray(webPageLd.breadcrumb.itemListElement)
      ? webPageLd.breadcrumb.itemListElement
      : [];
  const names = items
    .map((entry) => entry && entry.item && entry.item.name)
    .filter((name) => typeof name === 'string' && name.length > 0 && name.toLowerCase() !== 'home');
  return names.length > 0 ? names[names.length - 1] : undefined;
}

/**
 * DOM fallback for category, used only when the `WebPage` JSON-LD breadcrumb block is absent.
 * Verified live selector: `[data-testid="breadcrumbs-N"]` spans (`breadcrumbs-separator` is a
 * distinct, differently-suffixed `data-testid` and is excluded by the attribute selector itself).
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined}
 */
function extractCategoryFromDom($) {
  const labels = $('[data-testid^="breadcrumbs-"]')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0 && text.toLowerCase() !== 'home');
  return labels.length > 0 ? labels[labels.length - 1] : undefined;
}

/**
 * @param {Object} articleLd - `NewsArticle` JSON-LD block.
 * @returns {string[]} `keywords` filtered of known junk entries (see `KEYWORD_STOPWORDS`).
 */
function extractTagsFromLd(articleLd) {
  const keywords = Array.isArray(articleLd && articleLd.keywords) ? articleLd.keywords : [];
  return keywords
    .filter((kw) => typeof kw === 'string' && kw.trim().length > 0)
    .map((kw) => kw.trim())
    .filter((kw) => !KEYWORD_STOPWORDS.has(kw.toLowerCase()));
}

/**
 * DOM fallback for tags, used only when `NewsArticle.keywords` is absent/empty. Verified live
 * selector: `[data-testid="tag-list"] a` text list.
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractTagsFromDom($) {
  return $('[data-testid="tag-list"] a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0)
    .filter((tag) => !KEYWORD_STOPWORDS.has(tag.toLowerCase()));
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]} paragraphs from DOM `#article-description p.article-text` (verified
 *   live exact `id`/class pair, no ad/"Baca juga" noise observed inside it on either sampled
 *   article — see module header caveat on this assumption).
 */
function extractParagraphs($) {
  return $('#article-description p.article-text')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

/**
 * @param {string} html - article HTML (fetched or fixture).
 * @param {Object} [ctx]
 * @returns {Promise<Object>} raw ParsedArticle-like draft (camelCase); see coreAdapter.js for
 *   the mapping to the core snake_case shape + the field-provenance matrix.
 */
async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);
  const ldBlocks = extractJsonLdBlocks($);
  const articleLd = findByType(ldBlocks, 'NewsArticle') || {};
  const webPageLd = findByType(ldBlocks, 'WebPage');

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (webPageLd && webPageLd.url) ||
    undefined;

  const title =
    articleLd.headline ||
    $('h1[data-testid="title-article"]').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const ldDescription = typeof articleLd.description === 'string' ? articleLd.description.trim() : '';
  const summary =
    ldDescription ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const ldAuthors = Array.isArray(articleLd.author) ? articleLd.author : articleLd.author ? [articleLd.author] : [];
  const author =
    (ldAuthors[0] && typeof ldAuthors[0].name === 'string' && ldAuthors[0].name.trim()) ||
    $('[data-testid="author-article-1"]').first().text().trim() ||
    undefined;

  const publishedAt =
    toIsoOrUndefined(articleLd.datePublished) ||
    toIsoOrUndefined($('[data-testid="publish-date-article"] time').first().attr('datetime'));
  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const ldImage = articleLd.image;
  const thumbnailUrl =
    (ldImage && (typeof ldImage === 'string' ? ldImage : ldImage.url)) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const category = extractCategoryFromBreadcrumbLd(webPageLd) || extractCategoryFromDom($);

  const ldTags = extractTagsFromLd(articleLd);
  const tags = ldTags.length > 0 ? ldTags : extractTagsFromDom($);

  const externalArticleId = extractExternalId(url || '');

  let paragraphs = extractParagraphs($);
  if (paragraphs.length === 0 && typeof articleLd.articleBody === 'string' && articleLd.articleBody.trim()) {
    // Last-resort fallback: articleBody has no paragraph boundaries (verified live, sentences
    // run together with no separator), so it collapses to a single "paragraph" — see module
    // header caveat.
    paragraphs = [articleLd.articleBody.trim()];
  }

  return {
    sourceId: SOURCE_ID,
    url,
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
  // exported for unit tests / offline smoke script (fixtures/idn_times/smoke-test.js) and for
  // debugging extraction logic in isolation.
  isInScope,
  extractExternalId,
  stripTrackingParams,
  buildCategoryUrl,
  extractListingItems,
  parseListingDateTime,
  extractJsonLdBlocks,
  findByType,
  extractCategoryFromBreadcrumbLd,
  extractCategoryFromDom,
  extractTagsFromLd,
  extractTagsFromDom,
  extractParagraphs,
  discoverLive,
  isLiveDiscoverEnabled,
  ALLOWED_HOST,
  FIXTURE_LISTING_PATH,
  FIXTURE_ARTICLE_PATH,
};
