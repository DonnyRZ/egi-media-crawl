'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Media Indonesia (mediaindonesia.com) adapter — Sprint 6a (S6a-C). camelCase raw adapter,
 * following the same fixture-first pattern as `src/adapters/tirto/index.js` /
 * `src/adapters/tempo/index.js` / `src/adapters/okezone/index.js`. `./coreAdapter.js` bridges
 * this to the snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (checked live 2026-07-24 via the sandboxed fetch tool
 * available to this assessment — a Markdown-rendering proxy, NOT a raw `curl`/`axios` HTML
 * dump, so exact CSS class names below are documented as best-effort/typical-CMS-convention
 * rather than "verified live" the way sibling adapters' selectors are; page TEXT content,
 * ORDER, and URL shapes, by contrast, WERE directly observed and are called out as such):
 *
 *  - **Host**: `mediaindonesia.com` and `www.mediaindonesia.com` (per task brief), both
 *    accepted in `isArticleUrl()`.
 *  - **Cloudflare fingerprint** (per task brief, and independently reproduced live): a bare/
 *    generic client hitting an `/indeks/{step}/{offset}` offset-pagination URL got Cloudflare's
 *    interstitial "Performing security verification" JS challenge page instead of listing HTML
 *    (observed live on `/indeks/20/40`), while the plain category root (`/ekonomi/20/40`) and
 *    every article/homepage fetch during this assessment returned normal HTML — i.e. some
 *    paths/clients are more likely to be challenged than others. This adapter therefore always
 *    sends a clear, browser-like product `User-Agent` (`CRAWLER_UA`, default matches every
 *    sibling adapter's `EGIMediaCrawler/0.1`) on any live request, exactly like `tirto`/`tempo`;
 *    regardless, `discover()`/`parse()` are fixture-first offline (see SAFETY note below) so a
 *    Cloudflare challenge on one path can never break the offline smoke test.
 *  - **Discovery, primary**: the site-wide `/indeks` HTML listing (verified live: a flat,
 *    server-rendered "Index Berita Harian Mediaindonesia.com" feed mixing every vertical —
 *    sport, lifestyle/"Jelita", politics, corporate PR pieces, etc). Per the task brief,
 *    `?page=` / `/page/N` are NOT used for pagination here (`STRIP_PAGE_PARAM`-style defensive
 *    stripping is still applied to `canonical_url` regardless, matching every sibling adapter);
 *    instead pagination is an offset PATH segment pair, `/indeks/{step}/{offset}`, confirmed
 *    live to be a real, distinct route from the bare `/indeks` (offset 0/page 1) — verified live
 *    that the SAME shape also works per-category, `/{kategori}/{step}/{offset}` (e.g.
 *    `/ekonomi/20/40` returned a normal "Ekonomi" listing page live). The task brief's own
 *    example (`/indeks/20/40…`) is read as `step=20` (items per page) with `offset` advancing in
 *    steps of `INDEKS_OFFSET_STEP` (20, 40, 60, ...) per subsequent page — `buildIndeksUrl()` /
 *    `buildCategoryUrl()` below implement exactly that shape. This adapter's own `discover()`
 *    only ever fetches page 1 of `/indeks` (or `ctx.channelUrl`/`ctx.category` if given); the
 *    offset builders are exported for a future backfill/pagination pass, not exercised in the
 *    default single-page discovery flow (mirrors Tirto's "no further pagination is implemented
 *    on purpose" stance for a first cut).
 *  - **Discovery, secondary**: `sitemap-news.xml` / a general article sitemap, per the task
 *    brief. Live fetches of a few plausible candidate paths (`/sitemap.xml`,
 *    `/sitemap-news.xml`, `/sitemap-article.xml`) all failed with a proxy-reported HTTP 500
 *    during this assessment (through the same sandboxed fetch tool used for the rest of this
 *    write-up), so the EXACT live path was not independently confirmed here.
 *    `extractSitemapUrls()` is still implemented against the standard Google News Sitemap
 *    schema (`<url><loc>...</loc><news:news><news:publication_date>...</news:publication_date>
 *    <news:title>...</news:title></news:news></url>`, per schema.org/Google Search Central) so
 *    this channel activates cleanly once ops confirms the exact live URL — `discover()` treats
 *    it as a best-effort secondary channel (graceful `[]` on any fetch/parse failure, never
 *    blocks the primary `/indeks` channel) and it is exercised offline today via
 *    `fixtures/media_indonesia/sitemap-news.xml`.
 *  - **Article URL shape** (verified live across every sampled article/gallery/video link):
 *    `https://mediaindonesia.com/{kanal}/{numericId}/{slug}` — exactly 3 path segments, the
 *    2nd purely numeric (e.g. `/jelita/913303/gerakan-anti-ruam-perluas-edukasi-ke-450-posyandu-
 *    dan-180-puskesmas`). `{kanal}` is an open set (verified live: `jelita`, `ekonomi`, and the
 *    site's own "Rubrikasi" footer additionally names `opini`, `politik-dan-hukum`,
 *    `humaniora`, `olahraga`, `weekend` — no closed enum is hardcoded, any kanal slug is
 *    accepted, same open-kanal-set stance as `tempo`/`okezone`'s rubrik handling).
 *    `{numericId}` is reused as `external_article_id`. Two live-observed shapes that would
 *    otherwise slip through a naive "3 segments, 2nd numeric" check are explicitly excluded:
 *      1. Video pages, `/video/detail_video/{id}-{slug}` — the 2nd segment here is the LITERAL
 *         word `detail_video`, not numeric, so `ARTICLE_PATH_PATTERN` already rejects it; `video`
 *         is additionally listed in `NON_ARTICLE_FIRST_SEGMENTS` for defense-in-depth/clarity.
 *      2. Photo galleries, `/galleries/detail_galleries/{id}-{slug}` — same shape/reasoning as
 *         video; `galleries` is in `NON_ARTICLE_FIRST_SEGMENTS` too. Per the general playbook
 *         (`Reliable-News-Article-Scraping.md` §14.6), out-of-scope content types like these
 *         should be recognized and left alone rather than silently mis-parsed as articles —
 *         this adapter does that via `isArticleUrl()` returning `false`, not by crashing.
 *    The OFFSET-PAGINATION collision risk (`/indeks/20/40`, `/{kategori}/20/40` — 3 segments,
 *    2nd segment `20` IS purely numeric) is excluded by a separate, more targeted rule:
 *    `ARTICLE_PATH_PATTERN`'s 3rd segment (the "slug") must contain at least one letter — real
 *    article slugs are always hyphenated words (verified live on every sample), while a
 *    pagination offset segment (`40`, `60`, ...) is purely digits. `indeks` itself is also
 *    listed in `NON_ARTICLE_FIRST_SEGMENTS` for defense-in-depth on top of that rule.
 *  - **Body**: per the task brief, `div.article` (trusted as given — this assessment's fetch
 *    tool strips markup so the exact class name could not be independently re-derived from raw
 *    HTML; `extractParagraphs()` below is written against exactly that selector). Noise
 *    verified live IN THE RENDERED TEXT (present as clearly separate lines/blocks in the
 *    fetched article, not inline mid-sentence): a "Baca juga : {related title}" recirculation
 *    line appearing between paragraphs, and a trailing "Cek berita dan artikel yg lain di
 *    Google News dan dan ikuti WhatsApp channel mediaindonesia.com" follow-us CTA appearing
 *    once at the very end of the body, after the last real paragraph. `BODY_NOISE_SELECTORS`
 *    strips both by (assumed, documented-as-such) wrapper class, and `extractParagraphs()`
 *    additionally regex-filters any leftover "Cek berita dan artikel..." text as defense-in-
 *    depth in case a future template change stops wrapping it in its own element. A trailing
 *    journalist sign-off code (e.g. "(H-2)", verified live) is real editorial content and is
 *    deliberately NOT stripped, same "don't invent/over-clean" stance as every sibling adapter.
 *  - **Premium/teaser articles — documented, not faked** (per task brief): no live Media
 *    Indonesia paywalled/teaser-only article was actually observed during this assessment
 *    (unlike Tempo Plus, which has a directly-verified `isAccessibleForFree` JSON-LD flag) — MI
 *    appears to be predominantly ad-supported/free. Per the brief's explicit instruction to
 *    "lower content_text confidence / document, don't fake full body" for any premium/teaser
 *    article that DOES turn up in production, this adapter still ships defensive, best-effort
 *    detection (`detectPremiumOrTeaser()`): (a) a small set of plausible marker
 *    selectors/classes (`PREMIUM_MARKER_SELECTORS`, e.g. `.premium-badge`, `.locked-content`,
 *    `[data-premium="true"]`) that would catch an explicit CMS paywall flag if one exists, (b)
 *    a small set of common Indonesian-publisher paywall/teaser CTA phrases
 *    (`PREMIUM_TEXT_MARKERS`, e.g. "berlangganan untuk membaca/melanjutkan", "konten premium"),
 *    and (c) a plain body-length floor (`MIN_FULL_CONTENT_CHARS`) below which a successfully-
 *    extracted `div.article` is treated as a likely teaser rather than a parse failure. Any of
 *    the three flips `isPremiumOrTeaser: true` on the parsed draft, which `coreAdapter.js`
 *    reads to drop `content_text`'s `field_provenance` confidence to `"low"` with an explanatory
 *    note — mirroring Tempo's `isAccessibleForFree` confidence-drop pattern exactly, per the
 *    task brief's own peer-reference instruction — WITHOUT ever synthesizing paragraphs that
 *    were not actually present in `div.article`. `fixtures/media_indonesia/sample-article-
 *    premium.html` exercises this path offline (short body + an explicit `.premium-badge`
 *    marker + a "Berlangganan untuk membaca artikel selengkapnya" CTA line).
 *  - **Metadata priority** (per the general playbook §15 "Prioritas Sumber Metadata" — meta tag
 *    > DOM > URL inference — deliberately chosen over "DOM first" here, UNLIKE Tirto, because
 *    this assessment could not independently confirm exact DOM class names via raw HTML; Open
 *    Graph / standard `article:*` meta tags are a near-universal CMS convention and are treated
 *    as the primary, more resilient signal, with DOM selectors kept only as secondary/fallback
 *    enhancements):
 *      - title/summary/thumbnail <- `og:title` / `meta[name=description]` (falling back to
 *        `og:description`) / `og:image`, with DOM (`<h1>`, `<title>`) and URL-based fallbacks.
 *      - **published_at** <- `meta[property="article:published_time"]` (assumed full ISO 8601
 *        with an explicit offset, standard Open Graph Article convention) PRIMARY, falling back
 *        to a DOM byline date string — verified LIVE TEXT FORMAT "D/M/YYYY HH:MM" (e.g.
 *        "21/7/2026 22:42", no weekday, no explicit "WIB" suffix in the rendered text) via
 *        `parseDateTimeSlash()`, assumed Asia/Jakarta local time (`+07:00`), same "no-tz means
 *        WIB" convention `tirto`/`suara`/`viva`/`okezone` already use elsewhere in this repo.
 *      - `updated_at_source` <- `meta[property="article:modified_time"]`, assumed no-tz
 *        `"YYYY-MM-DD HH:MM:SS"` (same WIB assumption as every sibling adapter's
 *        `dateModified`/`article:modified_time` handling) — this exact meta tag's live presence
 *        on Media Indonesia specifically was NOT independently confirmed (see header note above
 *        on this assessment's fetch-tool limitation); implemented defensively regardless since
 *        it costs nothing when absent (`updated_at_source` simply stays `undefined`).
 *      - author <- a best-effort DOM byline selector (`.byline .author`, `.date-author .author`)
 *        — verified LIVE that a plain author NAME (e.g. "Indrastuti") appears directly under the
 *        headline, ahead of the date — falling back to `meta[property="article:author"]` /
 *        `meta[name="author"]`.
 *      - category <- a best-effort DOM breadcrumb selector (`.breadcrumb a`, last non-"Beranda"/
 *        "Home" item), falling back to the `{kanal}` URL segment (verified live, e.g. "jelita",
 *        "ekonomi" — same URL-segment-fallback stance `cnn_indonesia`/`okezone` already take for
 *        their own `{kanal}`/breadcrumb pairing).
 *      - tags <- a best-effort DOM tag-pill selector (`.tag-list a`, `.tags a`) — verified LIVE
 *        that tag pills render with a leading "#" in their text (e.g. "# Hari Anak Nasional (HAN)
 *        2026"), which `extractTags()` strips before storing the plain tag label.
 *    No JSON-LD (`NewsArticle`/`Article`) dependency is used anywhere in this adapter: this
 *    assessment's fetch tool strips `<script>` blocks, so JSON-LD presence/absence on Media
 *    Indonesia could not be confirmed either way — rather than guess at a schema shape, this
 *    adapter relies solely on the two signal types that WERE directly observed (meta/OG tags,
 *    which are near-universal regardless of CMS internals, and the DOM/rendered text itself).
 *    A future revision can add a JSON-LD fast-path once its real shape is confirmed live,
 *    without changing this adapter's public contract.
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every sibling adapter); otherwise it
 * reads the bundled `fixtures/media_indonesia/indeks.html` + `fixtures/media_indonesia/
 * sitemap-news.xml` fixtures. `parse()` is fixture-first when no `html` is supplied (or
 * `ctx.fixtureOnly` is set), reading `fixtures/media_indonesia/sample-article.html` (or
 * `fixtures/media_indonesia/sample-article-premium.html` when `ctx.fixtureVariant ===
 * 'premium'`) — fixtures work fully offline regardless of any live Cloudflare behavior.
 */

const SOURCE_ID = 'media_indonesia';
const BASE_URL = 'https://mediaindonesia.com/';
const ALLOWED_HOSTS = new Set(['mediaindonesia.com', 'www.mediaindonesia.com']);

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'media_indonesia');
const FIXTURE_INDEKS_PATH = path.join(FIXTURES_DIR, 'indeks.html');
const FIXTURE_SITEMAP_PATH = path.join(FIXTURES_DIR, 'sitemap-news.xml');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');
const FIXTURE_ARTICLE_PREMIUM_PATH = path.join(FIXTURES_DIR, 'sample-article-premium.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range

// Live-observed pagination shape: `/indeks/{step}/{offset}` (see module header "Discovery,
// primary"). `step` is fixed at 20 (matches the task brief's own "/indeks/20/40..." example);
// `offset` advances by this same step per subsequent page (20, 40, 60, ...).
const INDEKS_OFFSET_STEP = 20;

// Best-effort secondary discovery channel path (see module header "Discovery, secondary" for
// why the exact live path is unconfirmed) — a Google News Sitemap-shaped document.
const SITEMAP_NEWS_URL = `${BASE_URL}sitemap-news.xml`;

// Article URLs: https://mediaindonesia.com/{kanal}/{numericId}/{slug}. The 3rd segment (slug)
// must contain at least one letter — this is what actually discriminates a real article slug
// from an offset-pagination segment (`/indeks/20/40`, `/{kategori}/20/40`), both of which are
// syntactically "3 segments, 2nd numeric" too. See module header "Article URL shape".
const ARTICLE_PATH_PATTERN = /^\/([a-z0-9-]+)\/(\d+)\/([a-z0-9-]+)\/?$/i;
const SLUG_HAS_LETTER_PATTERN = /[a-z]/i;

// Non-article first path segments, kept for defense-in-depth/clarity on top of
// ARTICLE_PATH_PATTERN's own numeric-2nd-segment + lettered-3rd-segment rules (see module
// header "Article URL shape"). `video`/`galleries` are out-of-scope content types (playbook
// §14.6); the rest are listing/utility/search pages, never articles.
const NON_ARTICLE_FIRST_SEGMENTS = new Set([
  'indeks',
  'video',
  'galleries',
  'e-paper',
  'epaper',
  'tag',
  'author',
  'penulis',
  'search',
  'pencarian',
  'foto',
]);

// Best-effort premium/teaser detection (see module header "Premium/teaser articles" — no live
// MI paywalled sample was observed during this assessment; this is intentionally defensive).
const PREMIUM_MARKER_SELECTORS = ['.premium-badge', '.artikel-premium', '.locked-content', '[data-premium="true"]'];
const PREMIUM_TEXT_MARKERS = [
  /berlangganan untuk (membaca|melanjutkan)/i,
  /baca selengkapnya di e-?paper/i,
  /konten premium/i,
  /khusus pelanggan/i,
];
const MIN_FULL_CONTENT_CHARS = 400;

// Body noise stripped from `div.article` before pulling `<p>`/`<h2>`/`<h3>` text — see module
// header "Body" note. Wrapper class names are assumed/documented-as-such (see module header
// preamble on this assessment's fetch-tool limitation), not independently verified via raw
// HTML; the plain-text regex filter in `extractParagraphs()` below is the real safety net.
const BODY_NOISE_SELECTORS = ['.baca-juga', '.follow-cta', '.share-widget', 'script', 'style', 'figcaption', '.ads', '.iklan', 'ins'];

// Trailing follow-us CTA verified live IN RENDERED TEXT, always appearing once at the very end
// of the body (see module header "Body" note) — filtered defensively even if a future template
// change stops wrapping it in `.follow-cta`.
const FOLLOW_CTA_PATTERN = /^cek berita dan artikel/i;

// "Baca juga : ..." recirculation line, verified live in rendered text as its own line (not
// inline mid-sentence) — filtered defensively alongside the `.baca-juga` selector above.
const BACA_JUGA_PATTERN = /^baca juga\s*:/i;

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Media Indonesia',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 30,
    overlapHours: 4,
    enabled: true,
  };
}

function isInScope(absoluteUrl) {
  try {
    return ALLOWED_HOSTS.has(new URL(absoluteUrl).hostname.toLowerCase());
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
  const match = ARTICLE_PATH_PATTERN.exec(parsed.pathname);
  if (!match) {
    return false;
  }
  const [, firstSegment, , slug] = match;
  if (NON_ARTICLE_FIRST_SEGMENTS.has(firstSegment.toLowerCase())) {
    return false;
  }
  return SLUG_HAS_LETTER_PATTERN.test(slug);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url`. Per the task
 * brief, `?page=`/`/page/N` are ineffective/unused for Media Indonesia's own pagination (which
 * is offset-path-based instead — see module header), but this strip is applied regardless,
 * mirroring the invariant every other adapter in this repo defends unconditionally.
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
 * @returns {string|undefined} the numeric `{numericId}` path segment (2nd of 3), reused as
 *   `external_article_id` (see module header "Article URL shape").
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const match = ARTICLE_PATH_PATTERN.exec(new URL(url).pathname);
    return match ? match[2] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the `{kanal}` path segment (1st of 3), used as a discovery-time
 *   category hint and as `category`'s URL-based fallback (see module header "Metadata
 *   priority").
 */
function extractKanalFromUrl(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[0] || undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {{offset?: number}} [opts] - `offset` advances in `INDEKS_OFFSET_STEP` increments
 *   (20, 40, 60, ...); `0`/`undefined` returns the bare `/indeks` (page 1). See module header
 *   "Discovery, primary".
 * @returns {string}
 */
function buildIndeksUrl({ offset } = {}) {
  if (!Number.isInteger(offset) || offset <= 0) {
    return `${BASE_URL}indeks`;
  }
  return `${BASE_URL}indeks/${INDEKS_OFFSET_STEP}/${offset}`;
}

/**
 * @param {{category: string, offset?: number}} opts - same offset shape as `buildIndeksUrl()`,
 *   applied per-category (verified live on `/ekonomi/20/40` — see module header).
 * @returns {string}
 */
function buildCategoryUrl({ category, offset } = {}) {
  const kanal = category || 'indeks';
  if (!Number.isInteger(offset) || offset <= 0) {
    return `${BASE_URL}${kanal}`;
  }
  return `${BASE_URL}${kanal}/${INDEKS_OFFSET_STEP}/${offset}`;
}

/**
 * @param {string} text - e.g. "24/7/2026 16:32" (verified live listing/byline date format,
 *   "D/M/YYYY HH:mm", no weekday, no explicit "WIB" suffix in rendered text).
 * @returns {string|undefined} ISO 8601 string, assuming `+07:00` (WIB, same "no-tz means WIB"
 *   convention used across this repo).
 */
function parseDateTimeSlash(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, month, year, hour, minute] = match;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {string|undefined} value - assumed no-tz `"YYYY-MM-DD HH:MM:SS"` (see module header
 *   "Metadata priority" note on `article:modified_time`).
 * @returns {string|undefined} ISO 8601 string, assuming `+07:00` (WIB).
 */
function parseNoTzWibDateTime(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = hasTz ? value : `${value.trim().replace(' ', 'T')}+07:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {string|undefined} value - assumed full ISO 8601 with an explicit offset (standard
 *   Open Graph Article convention).
 * @returns {string|undefined}
 */
function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Parses an `/indeks` (or category) listing page into discovery entries. Card markup below
 * (`.indeks-item` / `.indeks-item-link` / `.indeks-item-title` / `.indeks-item-date`) is this
 * adapter's own documented fixture convention (see module header preamble on this assessment's
 * fetch-tool limitation re: exact live class names) — swap in the live selector once confirmed
 * operationally; the surrounding extraction/limit/dedup logic is unaffected either way.
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, normalizedUrl?: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function parseIndeksHtml(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('.indeks-item').each((_, el) => {
    if (items.length >= limit) return;
    const $el = $(el);
    const href = $el.find('a.indeks-item-link').first().attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    items.push({
      rawUrl: href,
      normalizedUrl: stripPageParam(href),
      listingTitle: $el.find('.indeks-item-title').first().text().trim() || undefined,
      publishedHint: parseDateTimeSlash($el.find('.indeks-item-date').first().text().trim()),
      categoryHint: extractKanalFromUrl(href),
      externalId: extractExternalId(href),
    });
  });

  return items.slice(0, limit);
}

/**
 * Parses a Google News Sitemap-shaped `sitemap-news.xml` document (see module header
 * "Discovery, secondary") into discovery entries. Regex-based extraction of the `news:*`
 * namespaced elements is used instead of a cheerio namespace selector for robustness across
 * cheerio/htmlparser2 XML-namespace quirks.
 * @param {string} xml
 * @param {number} limit
 * @returns {Array<{rawUrl: string, normalizedUrl?: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function extractSitemapUrls(xml, limit) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  const seen = new Set();

  $('url').each((_, el) => {
    if (items.length >= limit) return;
    const $el = $(el);
    const loc = $el.find('loc').first().text().trim();
    if (!loc || seen.has(loc) || !isArticleUrl(loc)) return;
    seen.add(loc);

    const rawBlock = $.html(el);
    const titleMatch = /<news:title>([\s\S]*?)<\/news:title>/.exec(rawBlock);
    const pubDateMatch = /<news:publication_date>([\s\S]*?)<\/news:publication_date>/.exec(rawBlock);
    const lastmod = $el.find('lastmod').first().text().trim();

    items.push({
      rawUrl: loc,
      normalizedUrl: stripPageParam(loc),
      listingTitle: (titleMatch && titleMatch[1].trim()) || undefined,
      publishedHint: toIsoOrUndefined((pubDateMatch && pubDateMatch[1].trim()) || lastmod) || undefined,
      categoryHint: extractKanalFromUrl(loc),
      externalId: extractExternalId(loc),
    });
  });

  return items.slice(0, limit);
}

/**
 * Fetches one page over HTTP, returning `undefined` on any non-2xx/network failure (never
 * throws) so callers can fall back to the bundled fixture.
 * @param {string} url
 * @returns {Promise<string|undefined>}
 */
async function fetchLivePage(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': CRAWLER_UA },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
      responseType: 'text',
    });
    if (response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
      return response.data;
    }
  } catch (_err) {
    // fall through
  }
  return undefined;
}

/**
 * Discovers candidate article URLs from BOTH channels described in the module header: the
 * primary `/indeks` HTML listing (or `ctx.channelUrl`/`ctx.category` to target a specific page)
 * and the secondary `sitemap-news.xml`. Each channel independently falls back to its own
 * bundled fixture on a live failure/empty result (same graceful-degrade pattern as `detik/
 * index.js`/`okezone/index.js`), and the union is deduped before honoring `ctx.limit`.
 * @param {{limit?: number, channelUrl?: string, category?: string, offset?: number,
 *   logger?: {warn?: Function}, liveDiscover?: boolean}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const logger = ctx.logger || console;
  const live = isLiveDiscoverEnabled(ctx);

  const indeksUrl = ctx.channelUrl || (ctx.category ? buildCategoryUrl({ category: ctx.category, offset: ctx.offset }) : buildIndeksUrl({ offset: ctx.offset }));

  let indeksHtml;
  let indeksChannelTag = 'indeks_html';
  if (live) {
    indeksHtml = await fetchLivePage(indeksUrl);
    if (!indeksHtml && typeof logger.warn === 'function') {
      logger.warn('[media_indonesia] discover(): live /indeks fetch failed; falling back to fixture');
    }
  }
  if (!indeksHtml) {
    indeksHtml = readFixture(FIXTURE_INDEKS_PATH);
    indeksChannelTag = live ? 'indeks_html:fixture_fallback' : 'indeks_html:fixture';
  }
  const indeksItems = parseIndeksHtml(indeksHtml, limit).map((item) => ({ ...item, discoveryChannel: indeksChannelTag }));

  let sitemapXml;
  let sitemapChannelTag = 'sitemap_news';
  if (live) {
    sitemapXml = await fetchLivePage(SITEMAP_NEWS_URL);
    if (!sitemapXml && typeof logger.warn === 'function') {
      logger.warn('[media_indonesia] discover(): live sitemap-news.xml fetch failed; falling back to fixture');
    }
  }
  if (!sitemapXml) {
    sitemapXml = readFixture(FIXTURE_SITEMAP_PATH);
    sitemapChannelTag = live ? 'sitemap_news:fixture_fallback' : 'sitemap_news:fixture';
  }

  let sitemapItems = [];
  try {
    sitemapItems = extractSitemapUrls(sitemapXml, limit).map((item) => ({ ...item, discoveryChannel: sitemapChannelTag }));
  } catch (_err) {
    sitemapItems = []; // best-effort secondary channel — never blocks the primary one.
  }

  const merged = [];
  const seen = new Set();
  for (const item of [...indeksItems, ...sitemapItems]) {
    if (seen.has(item.rawUrl)) continue;
    seen.add(item.rawUrl);
    merged.push(item);
  }

  return { items: merged.slice(0, limit) };
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]} breadcrumb labels in order (best-effort selector — see module header
 *   "Metadata priority").
 */
function extractBreadcrumbLabels($) {
  return $('.breadcrumb a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
}

/**
 * @param {cheerio.CheerioAPI} $
 * @param {string|undefined} url
 * @returns {string|undefined} last non-"Beranda"/"Home" breadcrumb label, falling back to the
 *   `{kanal}` URL segment (see module header "Metadata priority").
 */
function extractCategory($, url) {
  const labels = extractBreadcrumbLabels($).filter((label) => !['beranda', 'home'].includes(label.toLowerCase()));
  if (labels.length > 0) {
    return labels[labels.length - 1];
  }
  return extractKanalFromUrl(url);
}

/**
 * Extracts the tag-pill widget list, stripping the leading "#" marker verified live in the
 * rendered tag text (e.g. "# Hari Anak Nasional (HAN) 2026" -> "Hari Anak Nasional (HAN) 2026").
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractTags($) {
  const seen = new Set();
  const tags = [];
  $('.tag-list a, .tags a').each((_, el) => {
    const tag = $(el).text().trim().replace(/^#\s*/, '');
    if (!tag) return;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  });
  return tags;
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined}
 */
function extractAuthor($) {
  return (
    $('.byline .author').first().text().trim() ||
    $('.date-author .author').first().text().trim() ||
    $('meta[property="article:author"]').attr('content') ||
    $('meta[name="author"]').attr('content') ||
    undefined
  );
}

/**
 * @param {cheerio.CheerioAPI} $
 * @param {string} contentText - already-extracted, noise-stripped body text.
 * @returns {boolean} true if this article looks like a premium/teaser-only piece (see module
 *   header "Premium/teaser articles").
 */
function detectPremiumOrTeaser($, contentText) {
  const hasMarkerEl = PREMIUM_MARKER_SELECTORS.some((sel) => {
    try {
      return $(sel).length > 0;
    } catch (_err) {
      return false;
    }
  });
  const bodyLower = (contentText || '').toLowerCase();
  const hasMarkerText = PREMIUM_TEXT_MARKERS.some((re) => re.test(bodyLower));
  const isSuspiciouslyShort = contentText.length > 0 && contentText.length < MIN_FULL_CONTENT_CHARS;
  return hasMarkerEl || hasMarkerText || isSuspiciouslyShort;
}

/**
 * Removes known noise (recirculation/CTA/ad blocks, scripts, captions) from a clone of `div.
 * article` (per the task brief), then returns the cleaned-up `<p>`/`<h2>`/`<h3>` text as
 * paragraphs, in document order. A trailing journalist sign-off code (e.g. "(H-2)") is real
 * editorial content and is deliberately kept — see module header "Body".
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractParagraphs($) {
  const bodyEl = $('div.article').first();
  if (!bodyEl || bodyEl.length === 0) return [];

  const cleaned = bodyEl.clone();
  cleaned.find(BODY_NOISE_SELECTORS.join(', ')).remove();

  return cleaned
    .find('p, h2, h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0 && !FOLLOW_CTA_PATTERN.test(text) && !BACA_JUGA_PATTERN.test(text));
}

/**
 * @param {string} html - page HTML (fetched or fixture).
 * @param {{url?: string, fixtureOnly?: boolean, fixtureVariant?: 'premium'}} [ctx]
 * @returns {Promise<Object>} raw ParsedArticle-like draft (camelCase); see coreAdapter.js for
 *   the mapping to the core snake_case shape + the field-provenance matrix.
 */
async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const wantsPremiumFixture = Boolean(ctx && ctx.fixtureVariant === 'premium');
  const rawHtml = useFixture ? readFixture(wantsPremiumFixture ? FIXTURE_ARTICLE_PREMIUM_PATH : FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    undefined;

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    $('title').text().trim().replace(/\s*[-|]\s*Media Indonesia\s*$/i, '');

  const summary =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    undefined;

  const thumbnailUrl = $('meta[property="og:image"]').attr('content') || undefined;

  const publishedAt =
    toIsoOrUndefined($('meta[property="article:published_time"]').attr('content')) ||
    parseDateTimeSlash($('.byline .date, .date-author .date').first().text().trim());

  const updatedAt = parseNoTzWibDateTime($('meta[property="article:modified_time"]').attr('content'));

  const author = extractAuthor($);
  const category = extractCategory($, url);
  const tags = extractTags($);
  const externalArticleId = extractExternalId(url) || undefined;

  const paragraphs = extractParagraphs($);
  const isPremiumOrTeaser = detectPremiumOrTeaser($, paragraphs.join('\n\n'));

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
    isPremiumOrTeaser,
    rawHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/media_indonesia/smoke-test.js)
  // and for debugging extraction logic in isolation.
  isInScope,
  extractExternalId,
  extractKanalFromUrl,
  stripPageParam,
  buildIndeksUrl,
  buildCategoryUrl,
  parseIndeksHtml,
  extractSitemapUrls,
  parseDateTimeSlash,
  parseNoTzWibDateTime,
  extractBreadcrumbLabels,
  extractCategory,
  extractTags,
  extractAuthor,
  detectPremiumOrTeaser,
  extractParagraphs,
  discoverLive: async (ctx) => discover({ ...ctx, liveDiscover: true }),
  isLiveDiscoverEnabled,
  INDEKS_OFFSET_STEP,
  MIN_FULL_CONTENT_CHARS,
  FIXTURE_INDEKS_PATH,
  FIXTURE_SITEMAP_PATH,
  FIXTURE_ARTICLE_PATH,
  FIXTURE_ARTICLE_PREMIUM_PATH,
};
