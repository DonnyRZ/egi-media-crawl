'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * BeritaSatu (www.beritasatu.com) adapter — Sprint 6b (S6b-B). camelCase raw adapter,
 * following the same fixture-first pattern as `src/adapters/media_indonesia/index.js` /
 * `src/adapters/tempo/index.js` / `src/adapters/republika/index.js`. `./coreAdapter.js` bridges
 * this to the snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment: **restricted** (verified live 2026-07-24 via direct `curl` fetches of
 * `https://www.beritasatu.com/terkini/indeks` and several article/sitemap/robots.txt paths):
 *
 *  - **CloudFront WAF blocks non-browser-shaped `User-Agent`s with a bare HTTP 403** — verified
 *    live that this repo's usual sibling-adapter convention, a plain product token UA
 *    (`EGIMediaCrawler/0.1`, and generic `curl/8.0`, and anything containing the literal word
 *    "bot") ALL get 403'd, while a standard desktop Chrome `User-Agent` string gets a clean 200
 *    — AND, critically, a Chrome UA with this crawler's own product token APPENDED to the end
 *    (`"Mozilla/5.0 (...) Chrome/126.0.0.0 Safari/537.36 EGIMediaCrawler/0.1"`) is ALSO let
 *    through with 200. So CloudFront's check here is "does the UA look browser-shaped", not an
 *    exact-string allowlist — this adapter therefore always sends `LIVE_UA` (a real Chrome UA
 *    with our own product token honestly appended, NOT a bare bot/product token and NOT a
 *    spoofed `Googlebot`/other-crawler identity — see the task brief's explicit "do NOT spoof
 *    Googlebot" instruction) on any live request, distinct from every sibling adapter's plain
 *    `CRAWLER_UA` convention. `discover()`/`parse()` are fixture-first offline regardless (see
 *    SAFETY note below), so this CloudFront quirk can never break the offline smoke test.
 *  - Scope restricted to `www.beritasatu.com` (per the task brief's host) — `beritasatu.com`
 *    (no `www.`) is also accepted in `isArticleUrl()` since it is the same site, but every live
 *    sample's own `canonical`/`og:url` consistently uses the `www.` form.
 *  - **Discovery, primary**: the site-wide `/terkini/indeks` HTML listing (verified live: a
 *    flat, server-rendered feed mixing every vertical — nasional, ekonomi, sport, lifestyle,
 *    internasional, ototekno, multimedia, regional kanal, etc). Per the task brief, `?page=` is
 *    NOT used for pagination (defensive `stripPageParam()` is still applied to `canonical_url`
 *    regardless, matching every sibling adapter); instead pagination is a PATH segment,
 *    `/terkini/indeks/{N}` (verified live: page 1 is the bare `/terkini/indeks`, `N=2..7` are
 *    real distinct pages via the page's own `ul.pagination` links, and `N=8` 404s live — so
 *    ~7 pages total, exactly matching the task brief's "~7 pages" estimate). The SAME shape
 *    also works per-kanal, `/{kanal}/indeks` + `/{kanal}/indeks/{N}` (verified live on
 *    `/nasional/indeks` + `/nasional/indeks/2..7`, also 404s at `8`). The task brief's `/indeks`
 *    alias (no `terkini/` prefix) was ALSO verified live to return the same kind of listing
 *    page with HTTP 200 — `buildIndeksUrl()`/`buildCategoryUrl()` below implement all of these
 *    shapes; this adapter's own `discover()` only ever fetches page 1 by default (mirrors every
 *    sibling adapter's "no further pagination attempted in the default single-page discovery
 *    flow" stance for a first cut) — the page-builders are exported for a future backfill pass.
 *  - **Discovery, secondary**: a real, live-verified Google News Sitemap, but split PER-KANAL
 *    (`https://www.beritasatu.com/sitemap/{kanal}/news.xml`, discovered via the top-level
 *    `/sitemap.xml` sitemap INDEX, verified live to list ~15 kanal, each with both a `web.xml`
 *    and `news.xml` pair) — unlike Media Indonesia's single flat `sitemap-news.xml`, there is no
 *    one combined feed here. `buildSitemapNewsUrl()` defaults to the `nasional` kanal as this
 *    adapter's representative secondary channel (verified live: standard Google News Sitemap
 *    schema, `<url><loc>` CDATA-wrapped, `<news:publication_date>` already full ISO 8601 with an
 *    explicit `+07:00` offset); a future revision can walk every kanal from the sitemap index
 *    for full coverage, out of scope for this first cut (same stance as Media Indonesia's own
 *    secondary-channel scope note).
 *  - **robots.txt** (verified live, fetched with the browser-class UA): `Disallow: /widget/`,
 *    `/widgets/`, `/tag/`, `/search/`, `/network/` for `User-agent: *` — exactly the 4 path
 *    prefixes the task brief calls out. None of these can ever match `ARTICLE_PATH_PATTERN`
 *    (all are 1-2 path segments with no numeric id segment, so the pattern's own shape already
 *    excludes them), but they are still listed in `NON_ARTICLE_FIRST_SEGMENTS` for defense-in-
 *    depth/clarity and so `isArticleUrl()` short-circuits on them without even running the
 *    regex. A dedicated crawler bot list (`CCBot`, `PerplexityBot`, `Amazonbot`, `Bytespider`,
 *    etc, all `Disallow: /`) was also observed live but is irrelevant here since this adapter
 *    never identifies as any of those.
 *  - **Article URL shape** (verified live across every sampled article, spanning `nasional`,
 *    `ekonomi`, `sport`, `lifestyle`, `internasional`, `ototekno`, `multimedia`, `bplus`, and
 *    several regional kanal like `banten`/`jabar`): `https://www.beritasatu.com/{kanal}/
 *    {numericId}/{slug}` — exactly 3 path segments, the 2nd purely numeric (e.g.
 *    `/nasional/3013541/anak-indonesia-dilindungi-jaminan-kesehatan-nasional`). `{kanal}` is an
 *    open set (no closed enum hardcoded, same open-kanal-set stance as `tempo`/`media_indonesia`
 *    /`okezone`'s rubrik handling) — this also naturally covers the `bplus` ("BeritaSatu Plus")
 *    in-depth/analysis vertical, which was independently checked live for a paywall (per the
 *    task's general "document, don't fake" playbook stance on premium content) and found to
 *    ship its FULL body in `div.body-content` with no premium/teaser gate observed — so, unlike
 *    Tempo Plus / Media Indonesia's premium heuristic, no dedicated premium/teaser detection is
 *    implemented here; there is no live evidence BeritaSatu gates any sampled content this way.
 *    `{numericId}` is reused as `external_article_id` (also independently confirmed live to
 *    match the site's own internal `article_id` field, see "dataLayer" below). Two live-
 *    observed 2-segment shapes that would otherwise risk a false-positive on a naive "starts
 *    with 3 segments" check are already excluded by the regex itself (it requires exactly 3
 *    segments with a fully-numeric 2nd one): `/{kanal}/indeks` and `/{kanal}/indeks/{N}`
 *    (2nd segment is the literal word "indeks", never numeric) and `/penulis/{slug}` /
 *    `/editor/{slug}` (author/editor profile pages, only 2 segments). `NON_ARTICLE_FIRST_SEGMENTS`
 *    still lists `indeks`/`penulis`/`editor` explicitly for defense-in-depth/clarity on top of
 *    that structural exclusion, same spirit as Media Indonesia's own belt-and-suspenders list.
 *  - **`window.dataLayer` — a live-verified, near-complete metadata blob unique to this site
 *    among this repo's sources**: every sampled article page ships a `<script>` early in
 *    `<head>` calling `window.dataLayer.push({...})` with a FLAT, valid-JSON object (quoted
 *    keys AND string values, no nested objects — safely `JSON.parse()`-able after a targeted
 *    regex extraction, see `extractDataLayer()`) carrying `content_category` (e.g. "Nasional",
 *    "Sport", "B-Plus"), `sub_category` (a MORE specific sub-topic, e.g. "Kesra", "Voli",
 *    "B-Files" — verified live on 3 independent samples spanning 3 different top-level kanal),
 *    `published_date`/`detail_published_date` (Indonesian-locale strings, kept only as a
 *    fallback — see "Metadata priority" below), `penulis` (the REPORTER byline — verified live
 *    to match the JSON-LD `author[].name` on every sample, i.e. no Republika-style "Red:"-vs-
 *    "Rep:" ambiguity here), `editor`/`editor_id`, `article_id` (verified live IDENTICAL to the
 *    URL's own `{numericId}` path segment on every sample), and `tags` (a plain COMMA-separated
 *    string, e.g. `"BPJS Kesehatan,Program JKN,Anak Indonesia"` — verified live to match the
 *    DOM tag-pill widget's own 3 tags exactly on the same sample). This is treated as this
 *    adapter's PRIMARY source for `category`/`tags`/`external_article_id`/`author_name` (ahead
 *    of JSON-LD/DOM) precisely because it is a single, already-structured, verified-consistent
 *    blob — DOM/JSON-LD selectors are kept as fallbacks in case a future template drops it.
 *  - Article page carries 3 separate JSON-LD blocks (verified live, all 3 present on every
 *    sample): a `BreadcrumbList` (verified live to be genuinely SHALLOW — only `[Home, {kanal}]`,
 *    no sub-kanal level, e.g. `[Home, "nasional"]` lowercase URL-slug-cased — so this adapter
 *    does NOT rely on it for `category`, unlike Tempo/Media Indonesia's breadcrumb-based
 *    category; `dataLayer.sub_category` above is the actually-informative signal here), a bare
 *    `WebPage` block (redundant `headline`/`url`/`datePublished`/`image`, superseded by the 3rd
 *    block below), and a `NewsArticle` block carrying `headline`, `description`, `image`
 *    (an `ImageObject` with a `.url`, NOT a bare string — different shape from Tempo's bare-
 *    string `image`), `author` (an ARRAY of `Person`, verified live to always carry exactly one
 *    entry matching `dataLayer.penulis`), `publisher`, `datePublished`/`dateModified` (BOTH full
 *    ISO 8601 WITH an explicit `+07:00` offset already, verified live identical to each other
 *    on every sample — no distinct "last updated" signal was ever observed, same "no dateModified
 *    signal" situation Tempo documents for itself, except here the key IS present, just always
 *    equal to `datePublished`). NO `article:published_time`/`article:modified_time` OpenGraph
 *    meta tags were found live (checked directly) — only the generic `og:title`/`og:description`
 *    /`og:image`/`og:url`/`og:type=article` tags, so this adapter's date fields rely on JSON-LD/
 *    `dataLayer` only, not an `article:*` meta fallback (unlike Media Indonesia).
 *  - **Body**: `div.body-content` (verified live, exact class `"col b1-article body-content"` —
 *    `.body-content` alone is used as the selector since it is the more specific/stable class of
 *    the two). Noise verified live INSIDE this exact container (not a separate wrapper outside
 *    it, unlike Media Indonesia's `.baca-juga`/`.follow-cta`, which DO live outside their own
 *    body container): a "BACA JUGA" recirculation box, `<div style="background:#FFEBEB;...">`
 *    wrapping a `<p>BACA JUGA</p>` label AND an `<h2>` with the linked related-article title —
 *    verified live to appear 0-2+ times per article, always as its own sibling `<div>` (never
 *    inline mid-paragraph). Ad slots (`<div id="div-gpt-ad-...">` + inline `<script>`/`<style>`)
 *    also interleave the real `<p>` paragraphs but are naturally excluded since only `p`/`h2`
 *    tags are ever selected (scripts/styles/divs are not). `extractParagraphs()` below removes
 *    the WHOLE "BACA JUGA" wrapper div (via a `div:has(p:contains("BACA JUGA"))` selector,
 *    matching on the exact live-verified uppercase Indonesian label) before pulling `p`/`h2`
 *    text, which correctly drops BOTH the "BACA JUGA" label AND the related-article `<h2>` title
 *    it wraps (verified directly against a live-shaped fixture: removing by text-match alone,
 *    without removing the parent div, would have left the related title's `<h2>` behind). The
 *    site's own tag-pill widget (`<h3 class="badge ...">`, see below) also lives INSIDE
 *    `div.body-content` on the live page — but since it uses `<h3>`, not `<p>`/`<h2>`, and this
 *    adapter's paragraph selector is scoped to exactly `p, h2`, it is naturally excluded with no
 *    extra stripping needed (verified directly: no live sample had a genuine in-body `<h2>`
 *    subheading OTHER than the "BACA JUGA" box's own, so after that box is removed, 0 `<h2>`s
 *    remain — this differs from Media Indonesia, which DOES use `<h2>` for real subheadings).
 *    The "Simak berita ... Google News" / "Ikuti yang terbaru ... WhatsApp Channel" follow-CTA
 *    paragraphs (verified live, same follow-us spirit as Media Indonesia's own trailing CTA)
 *    live OUTSIDE `div.body-content` entirely (confirmed directly: `.body-content`'s own
 *    `.text()` never contains "Google News"/"WhatsApp Channel" on a live sample) — so, unlike
 *    Media Indonesia, no extra text-pattern filter is needed for them at all; they are simply
 *    never selected because they are not inside the body container.
 *  - `tags` <- the tag-pill widget, DOM `h3.badge` wrapped in a parent `<a>` whose `href` is an
 *    ABSOLUTE `/tag/...` URL (verified live, e.g. `<a href="https://www.beritasatu.com/tag/
 *    bpjs-kesehatan"><h3 class="badge ...">BPJS Kesehatan</h3></a>` — note this is NOT a
 *    relative href, unlike some sibling sites' own tag widgets, so `[href*="/tag/"]` is used
 *    rather than a relative-only `[href^="/tag/"]` prefix match) — used only as a FALLBACK here
 *    (see "dataLayer" above for the primary source); anchor text is already the clean display
 *    label (no leading "#" marker to strip here, unlike Media Indonesia's tag pills).
 *  - `author_name` <- `dataLayer.penulis` PRIMARY (the reporter byline, verified live to match
 *    JSON-LD `author[].name`); DOM fallback verified live as a "Penulis: **{name}** | Editor:
 *    {code}" byline block (`a[href*="/penulis/"]` with non-empty text, mirroring Tempo's own
 *    `/penulis/` DOM-fallback convention exactly, including the same defensive empty-text guard
 *    since the byline avatar circles are ALSO `<a>`-adjacent but not `<a>` tags themselves here
 *    so no extra empty-anchor filtering was actually needed on this site, unlike Tempo).
 *  - No live multipage ("halaman 1/2/...") markup was found on any sampled live article (every
 *    article ships as a single document, same as every sibling adapter observed to date) —
 *    `parse()` still defensively strips any `?page=` query param before using a URL as
 *    `canonical_url`, mirroring the invariant every other adapter in this repo defends
 *    regardless.
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every sibling adapter), and ALWAYS
 * uses `LIVE_UA` (the browser-class product UA documented above), never the bare
 * `EGIMediaCrawler/0.1`-style token every other adapter's `CRAWLER_UA` uses (which this site's
 * CloudFront WAF verified-live 403s). Otherwise it reads the bundled `fixtures/beritasatu/
 * indeks.html` + `fixtures/beritasatu/sitemap-news.xml` fixtures. `parse()` is fixture-first
 * when no `html` is supplied (or `ctx.fixtureOnly` is set), reading `fixtures/beritasatu/
 * sample-article.html` — fixtures work fully offline regardless of any live CloudFront
 * behavior, and were captured from real successful (HTTP 200, browser-class UA) live fetches
 * per the task brief's explicit instruction, then trimmed to a synthetic-but-schema-faithful
 * sample (same "real structure, synthetic text" convention every sibling fixture in this repo
 * already follows).
 */

const SOURCE_ID = 'beritasatu';
const BASE_URL = 'https://www.beritasatu.com/';
const ALLOWED_HOSTS = new Set(['www.beritasatu.com', 'beritasatu.com']);

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'beritasatu');
const FIXTURE_INDEKS_PATH = path.join(FIXTURES_DIR, 'indeks.html');
const FIXTURE_SITEMAP_PATH = path.join(FIXTURES_DIR, 'sitemap-news.xml');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

// **Restricted-assessment UA** (see module header "CloudFront WAF" note): a real desktop Chrome
// UA with this crawler's own product token honestly appended — verified live to pass CloudFront
// where a bare `EGIMediaCrawler/0.1` (every sibling adapter's plain `CRAWLER_UA`) or any UA
// containing "bot"/"curl" all 403. Deliberately NOT a spoofed Googlebot/other-crawler identity
// (task brief: "do NOT spoof Googlebot") — just a browser-shaped UA, honestly labeled.
const LIVE_UA =
  process.env.BERITASATU_LIVE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range

// Live-verified path pagination (see module header "Discovery, primary"): bare `/terkini/indeks`
// (or `/{kanal}/indeks`) is page 1; `/terkini/indeks/{N}` (or `/{kanal}/indeks/{N}`) for N=2..
// INDEKS_MAX_PAGE are real distinct pages; N=INDEKS_MAX_PAGE+1 404s live. `?page=` is ignored
// (per the task brief) and is never generated by this adapter's own builders.
const INDEKS_MAX_PAGE = 7;

// Representative kanal for the secondary sitemap channel (see module header "Discovery,
// secondary" — the real live sitemap is split per-kanal, there is no single flat file).
const DEFAULT_SITEMAP_KANAL = 'nasional';

// Article URLs are `/{kanal}/{numericId}/{slug}` (exactly 3 path segments, 2nd segment fully
// numeric) — see module header "Article URL shape". This alone excludes `/{kanal}/indeks`
// (2 segments) and `/{kanal}/indeks/{N}` (2nd segment is the word "indeks", never numeric).
const ARTICLE_PATH_PATTERN = /^\/([a-z0-9-]+)\/(\d+)\/([a-z0-9-]+)\/?$/i;

// robots.txt-disallowed prefixes (verified live, see module header "robots.txt") plus
// `indeks`/`penulis`/`editor` (listing/profile pages — see "Article URL shape"), kept here for
// defense-in-depth/clarity on top of ARTICLE_PATH_PATTERN's own structural exclusion.
const NON_ARTICLE_FIRST_SEGMENTS = new Set(['indeks', 'tag', 'search', 'widget', 'widgets', 'network', 'penulis', 'editor']);

// "BACA JUGA" recirculation box label, verified live to always be its own `<p>` inside a
// sibling `<div>` that ALSO wraps the linked related-article `<h2>` title (see module header
// "Body" note) — matched via cheerio's `:contains()` so the WHOLE wrapper div (label + title)
// is removed together, not just the label text.
const BACA_JUGA_LABEL = 'BACA JUGA';

// Indonesian full month names, as seen live in `dataLayer.detail_published_date`
// ("Jumat, 24 Juli 2026 | 16:39 WIB") — used only as a fallback: JSON-LD `datePublished` (full
// ISO 8601 with an explicit `+07:00` offset already) is the primary source and needs no such
// parsing.
const MONTH_INDEX_ID = {
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

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'BeritaSatu',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 60,
    overlapHours: 6,
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
  const [, firstSegment] = match;
  return !NON_ARTICLE_FIRST_SEGMENTS.has(firstSegment.toLowerCase());
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url`. Per the task
 * brief, `?page=` is ignored/unused for BeritaSatu's own pagination (which is path-based
 * instead — see module header), but this strip is applied regardless, mirroring the invariant
 * every other adapter in this repo defends unconditionally.
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
 *   `external_article_id` (see module header "Article URL shape") — used only as a fallback,
 *   `dataLayer.article_id` is the primary source in `parse()`.
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
 *   category hint and as `category`'s final URL-based fallback.
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
 * @param {{kanal?: string, page?: number}} [opts] - `page` is 1-based; `1`/`undefined` returns
 *   the bare `/terkini/indeks` (or `/{kanal}/indeks`). See module header "Discovery, primary".
 * @returns {string}
 */
function buildIndeksUrl({ kanal, page } = {}) {
  const prefix = kanal ? `${BASE_URL}${kanal}/indeks` : `${BASE_URL}terkini/indeks`;
  if (!Number.isInteger(page) || page <= 1) {
    return prefix;
  }
  return `${prefix}/${page}`;
}

/**
 * Per-kanal variant of `buildIndeksUrl()`, kept as a distinct named export for readability at
 * call sites that already have a specific kanal in hand (mirrors `buildIndeksUrl({kanal, page})`
 * exactly; both exist for symmetry with `media_indonesia`'s `buildIndeksUrl`/`buildCategoryUrl`
 * pair).
 * @param {{category: string, page?: number}} opts
 * @returns {string}
 */
function buildCategoryUrl({ category, page } = {}) {
  return buildIndeksUrl({ kanal: category, page });
}

/**
 * @param {string} [kanal] - defaults to `DEFAULT_SITEMAP_KANAL` (see module header "Discovery,
 *   secondary" — the real live sitemap is split per-kanal, there is no single flat file).
 * @returns {string}
 */
function buildSitemapNewsUrl(kanal) {
  return `${BASE_URL}sitemap/${kanal || DEFAULT_SITEMAP_KANAL}/news.xml`;
}

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {string} text - e.g. "Jumat, 24 Juli 2026 | 16:39 WIB" (verified live
 *   `dataLayer.detail_published_date` format — weekday name, comma, "D Month YYYY", " | ",
 *   "HH:MM", trailing "WIB"). Used only as a fallback: JSON-LD `datePublished` (full ISO 8601
 *   with an explicit `+07:00` offset already) is the primary source and needs no such parsing.
 * @returns {string|undefined} ISO 8601 string, assuming `+07:00` (WIB).
 */
function parseIndonesianDateTime(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*\|\s*(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX_ID[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Extracts the `window.dataLayer.push({...})` metadata blob (see module header "dataLayer" —
 * this repo's only source that ships this). The captured block is a flat, valid-JSON object
 * (quoted keys and string values, no nesting observed live), so a targeted regex + `JSON.parse`
 * is sufficient and avoids matching the unrelated `dataLayer.push(arguments)` GTM call that
 * also appears on every page. Defensive: returns `{}` (never throws) on any absent/malformed
 * input, since this is treated as a best-effort primary source with DOM/JSON-LD fallbacks.
 * @param {string} html
 * @returns {Object}
 */
function extractDataLayer(html) {
  if (typeof html !== 'string' || !html) return {};
  const match = /window\.dataLayer\.push\(\s*(\{[\s\S]*?\})\s*\)\s*;/.exec(html);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_err) {
    return {};
  }
}

/**
 * @param {string|undefined} csv - e.g. "BPJS Kesehatan,Program JKN,Anak Indonesia" (verified
 *   live `dataLayer.tags` format — plain comma-separated, no leading "#" marker to strip here).
 * @returns {string[]}
 */
function parseDataLayerTags(csv) {
  if (typeof csv !== 'string' || !csv.trim()) return [];
  return csv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
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

/**
 * @param {Object|Object[]|undefined} author - JSON-LD `NewsArticle.author` (verified live to be
 *   an ARRAY of `Person` with always exactly 1 entry on this site — no dedup needed the way
 *   Tempo's multi-byline-role array does, but this still defensively handles more than one).
 * @returns {string|undefined}
 */
function extractAuthorNames(author) {
  const list = Array.isArray(author) ? author : author ? [author] : [];
  const names = list.map((entry) => (entry && typeof entry.name === 'string' ? entry.name.trim() : '')).filter(Boolean);
  return names.length > 0 ? names.join(', ') : undefined;
}

/**
 * DOM fallback for author: the "Penulis: **{name}**" byline block, `a[href*="/penulis/"]` with
 * non-empty text (verified live — see module header "author_name" note).
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined}
 */
function extractAuthorFromDom($) {
  const name = $('a[href*="/penulis/"]').first().text().trim();
  return name || undefined;
}

/**
 * @param {Object|undefined} breadcrumbLd
 * @returns {string[]} breadcrumb labels in order, e.g. ["Home", "nasional"] (verified live
 *   `BreadcrumbList` shape — see module header "Body"/"category" notes: this is genuinely
 *   shallow, only 2 levels, no sub-kanal).
 */
function extractBreadcrumbLabels(breadcrumbLd) {
  const items = breadcrumbLd && Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  return items.map((entry) => entry && entry.name).filter((name) => typeof name === 'string' && name.length > 0);
}

/**
 * @param {string[]} breadcrumbLabels
 * @returns {string|undefined} the most specific (last) breadcrumb label, excluding "Home".
 */
function lastNonHomeBreadcrumb(breadcrumbLabels) {
  const withoutHome = breadcrumbLabels.filter((label) => label.toLowerCase() !== 'home');
  return withoutHome.length > 0 ? withoutHome[withoutHome.length - 1] : undefined;
}

/**
 * Extracts the tag-pill widget list, DOM `a[href*="/tag/"] h3.badge` (verified live — see
 * module header "tags" note; the anchor's `href` is an ABSOLUTE URL on this site, e.g.
 * `href="https://www.beritasatu.com/tag/bpjs-kesehatan"`, so `[href*="/tag/"]` is used rather
 * than a relative-only `[href^="/tag/"]` prefix match). Used only as a fallback to
 * `dataLayer.tags`.
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractTagsFromDom($) {
  const seen = new Set();
  const tags = [];
  $('a[href*="/tag/"]').each((_, el) => {
    const tag = $(el).text().trim();
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
 * Removes the "BACA JUGA" recirculation box (whole wrapper `<div>`, label + linked
 * related-article `<h2>` together — see module header "Body" note) from a clone of `div.
 * body-content`, then returns the cleaned-up `<p>`/`<h2>` text as paragraphs, in document
 * order. The site's own tag-pill `<h3>` widget also lives inside `div.body-content` but is
 * naturally excluded since only `p`/`h2` are selected.
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractParagraphs($) {
  const bodyEl = $('.body-content').first();
  if (!bodyEl || bodyEl.length === 0) return [];

  const cleaned = bodyEl.clone();
  cleaned.find(`div:has(p:contains("${BACA_JUGA_LABEL}"))`).remove();
  cleaned.find('script, style').remove();

  return cleaned
    .find('p, h2')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

/**
 * Parses a `/terkini/indeks` (or `/{kanal}/indeks`) listing page into discovery entries. Card
 * markup (`.row.gx-3.mt-4.position-relative` > `a.stretched-link` / `h2` / `.b1-box-category` /
 * `.b1-date`) is the verified-live listing item shape (see module header "Discovery, primary")
 * — deliberately distinct from the page's OWN top-nav "mega menu" preview cards (`.col-4.
 * position-relative`, no `.row`/`.gx-3`/`.mt-4` classes), which this selector does not match.
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, normalizedUrl?: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function extractIndeksItems(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('.row.gx-3.mt-4.position-relative').each((_, el) => {
    if (items.length >= limit) return;
    const $el = $(el);
    const href = $el.find('a.stretched-link').first().attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    items.push({
      rawUrl: href,
      normalizedUrl: stripPageParam(href),
      listingTitle: $el.find('h2').first().text().trim() || undefined,
      categoryHint: $el.find('.b1-box-category').first().text().trim() || extractKanalFromUrl(href),
      externalId: extractExternalId(href),
    });
  });

  return items.slice(0, limit);
}

/**
 * Parses a Google News Sitemap-shaped `/sitemap/{kanal}/news.xml` document (see module header
 * "Discovery, secondary") into discovery entries. `<loc>`/`<news:title>` are CDATA-wrapped on
 * this site (verified live) — cheerio's `.text()` already unwraps CDATA transparently, so no
 * extra regex is needed here (unlike Media Indonesia's namespaced-element regex workaround).
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

    items.push({
      rawUrl: loc,
      normalizedUrl: stripPageParam(loc),
      listingTitle: $el.find('news\\:title, title').first().text().trim() || undefined,
      publishedHint: toIsoOrUndefined($el.find('news\\:publication_date, publication_date').first().text().trim()) || undefined,
      categoryHint: extractKanalFromUrl(loc),
      externalId: extractExternalId(loc),
    });
  });

  return items.slice(0, limit);
}

/**
 * Fetches one page over HTTP with `LIVE_UA` (see module header "CloudFront WAF" note),
 * returning `undefined` on any non-2xx/network failure (never throws) so callers can fall back
 * to the bundled fixture.
 * @param {string} url
 * @returns {Promise<string|undefined>}
 */
async function fetchLivePage(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': LIVE_UA },
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
 * primary `/terkini/indeks` HTML listing (or `ctx.channelUrl`/`ctx.category`/`ctx.page` to
 * target a specific page) and the secondary per-kanal `sitemap/{kanal}/news.xml`. Each channel
 * independently falls back to its own bundled fixture on a live failure/empty result (same
 * graceful-degrade pattern as `media_indonesia/index.js`), and the union is deduped before
 * honoring `ctx.limit`.
 * @param {{limit?: number, channelUrl?: string, category?: string, page?: number,
 *   sitemapKanal?: string, logger?: {warn?: Function}, liveDiscover?: boolean}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const logger = ctx.logger || console;
  const live = isLiveDiscoverEnabled(ctx);

  const indeksUrl = ctx.channelUrl || buildIndeksUrl({ kanal: ctx.category, page: ctx.page });

  let indeksHtml;
  let indeksChannelTag = 'indeks_html';
  if (live) {
    indeksHtml = await fetchLivePage(indeksUrl);
    if (!indeksHtml && typeof logger.warn === 'function') {
      logger.warn('[beritasatu] discover(): live /terkini/indeks fetch failed; falling back to fixture');
    }
  }
  if (!indeksHtml) {
    indeksHtml = readFixture(FIXTURE_INDEKS_PATH);
    indeksChannelTag = live ? 'indeks_html:fixture_fallback' : 'indeks_html:fixture';
  }
  const indeksItems = extractIndeksItems(indeksHtml, limit).map((item) => ({ ...item, discoveryChannel: indeksChannelTag }));

  const sitemapUrl = buildSitemapNewsUrl(ctx.sitemapKanal);
  let sitemapXml;
  let sitemapChannelTag = 'sitemap_news';
  if (live) {
    sitemapXml = await fetchLivePage(sitemapUrl);
    if (!sitemapXml && typeof logger.warn === 'function') {
      logger.warn('[beritasatu] discover(): live sitemap news.xml fetch failed; falling back to fixture');
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
 * @param {string} html - page HTML (fetched or fixture).
 * @param {{url?: string, fixtureOnly?: boolean}} [ctx]
 * @returns {Promise<Object>} raw ParsedArticle-like draft (camelCase); see coreAdapter.js for
 *   the mapping to the core snake_case shape + the field-provenance matrix.
 */
async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);
  const ldBlocks = extractJsonLdBlocks($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};
  const breadcrumbLd = findBreadcrumbLd(ldBlocks);
  const dataLayer = extractDataLayer(rawHtml);

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && articleLd.mainEntityOfPage['@id']) ||
    undefined;

  const title =
    articleLd.headline ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    $('title').text().trim();

  const summary =
    articleLd.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const thumbnailUrl =
    (articleLd.image && typeof articleLd.image === 'object' && articleLd.image.url) ||
    (typeof articleLd.image === 'string' && articleLd.image) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const author = (typeof dataLayer.penulis === 'string' && dataLayer.penulis.trim()) || extractAuthorNames(articleLd.author) || extractAuthorFromDom($);

  const publishedAt = toIsoOrUndefined(articleLd.datePublished) || parseIndonesianDateTime(dataLayer.detail_published_date);
  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const breadcrumbLabels = extractBreadcrumbLabels(breadcrumbLd);
  const category =
    (typeof dataLayer.sub_category === 'string' && dataLayer.sub_category.trim()) ||
    (typeof dataLayer.content_category === 'string' && dataLayer.content_category.trim()) ||
    lastNonHomeBreadcrumb(breadcrumbLabels) ||
    extractKanalFromUrl(url);

  const tags = parseDataLayerTags(dataLayer.tags);
  const finalTags = tags.length > 0 ? tags : extractTagsFromDom($);

  const externalArticleId = (typeof dataLayer.article_id === 'string' && dataLayer.article_id.trim()) || extractExternalId(url) || undefined;

  const paragraphs = extractParagraphs($);

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
    tags: finalTags,
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
  // exported for unit tests / offline smoke script (fixtures/beritasatu/smoke-test.js) and for
  // debugging extraction logic in isolation.
  isInScope,
  extractExternalId,
  extractKanalFromUrl,
  stripPageParam,
  buildIndeksUrl,
  buildCategoryUrl,
  buildSitemapNewsUrl,
  extractIndeksItems,
  extractSitemapUrls,
  extractDataLayer,
  parseDataLayerTags,
  parseIndonesianDateTime,
  extractJsonLdBlocks,
  findNewsArticleLd,
  findBreadcrumbLd,
  extractAuthorNames,
  extractAuthorFromDom,
  extractBreadcrumbLabels,
  lastNonHomeBreadcrumb,
  extractTagsFromDom,
  extractParagraphs,
  discoverLive: async (ctx) => discover({ ...ctx, liveDiscover: true }),
  isLiveDiscoverEnabled,
  INDEKS_MAX_PAGE,
  DEFAULT_SITEMAP_KANAL,
  LIVE_UA,
  FIXTURE_INDEKS_PATH,
  FIXTURE_SITEMAP_PATH,
  FIXTURE_ARTICLE_PATH,
};
