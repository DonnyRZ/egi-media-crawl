'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Tribunnews (www.tribunnews.com) adapter — Sprint 6b (S6b-C). camelCase raw adapter,
 * following the same fixture-first pattern as `src/adapters/tempo/index.js` / `src/adapters/
 * viva/index.js` / `src/adapters/media_indonesia/index.js`. `./coreAdapter.js` bridges this to
 * the snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment: **restricted**. Verified live 2026-07-24 with direct `curl` requests (both from
 * this sandbox's own network path, not a proxy) against a real article URL:
 *   - a bare/generic UA (e.g. `curl`'s default, and this repo's own `EGIMediaCrawler/0.1`
 *     `CRAWLER_UA` convention) gets an HTTP 403 from CloudFront on EVERY path tried (article,
 *     homepage) — confirmed by both the raw crawler UA and axios's own default UA string.
 *   - a genuine desktop-Chrome UA gets a normal HTTP 200 with full HTML on the exact same URLs.
 *   This adapter therefore does NOT reuse the shared `CRAWLER_UA` convention for its own live
 *   requests (that string is exactly what CloudFront blocks here) — see `LIVE_UA` below.
 *
 * Host scope: **`www.tribunnews.com` ONLY** (per task brief). Tribunnews is the flagship of a
 * ~40-site regional "Tribun Network" (Tribun Jabar, Tribun Jogja, Serambi Indonesia, Warta
 * Kota, ...), all on entirely different domains — none of those are in `ALLOWED_HOSTS` and
 * none are treated as this source. The mobile mirror `m.tribunnews.com` (verified live via
 * `<link rel="alternate" media="only screen and (max-width: 640px)">` on every article) is
 * ALSO excluded — same tight "www only" scope, no subdomain aliases accepted.
 *
 * Robots.txt (fetched live 2026-07-24, `https://www.tribunnews.com/robots.txt`): disallows
 * `/api/`, `/posts/`, `/ajax/`, `/json/`, `/auth/`, `/member/`, `/komentar/`, `/search`,
 * `/tag/`, `/topic/` for the default `User-agent: *` group (this adapter/live client identifies
 * as a generic UA, not as one of the explicitly-named `Allow: /` bots like Googlebot/bingbot —
 * see `LIVE_UA` note above on why NOT spoofing one of those named bots is a deliberate,
 * task-brief-mandated choice). `NON_ARTICLE_FIRST_SEGMENTS` below excludes all of these path
 * prefixes (plus a few more live-observed non-article routes: `penulis`/`editor` author-profile
 * pages, `epaper`, `images`/`webstories`/`foto`/`video` non-text content, `index-news` itself).
 * Sitemap declared at `https://www.tribunnews.com/sitemap.xml` (verified live — a
 * `sitemapindex` of per-section `{section}/sitemap-news.xml|-web.xml|-images.xml`).
 *
 * Discovery, primary — **`/index-news` HTML index** (verified live, ~20 items/page in
 * `ul.lsi > li`, each with `<time class="grey">{Indonesian date}</time>` + `<h3><a href=.../
 * title=...>{title}</a></h3>`, some additionally prefixed by a `<h4 class="red ..."><a
 * href="/topic/...">{topic}</a></h4>` "topic" pill — that h4/topic link is NOT an article link
 * and is ignored). Pagination is `?page=N` — verified live this DOES change the returned items
 * (page 2 showed genuinely different, older articles than page 1) — but per the task brief,
 * page 11+ repeats page 10's content, so `MAX_INDEX_PAGE` hard-caps at 10; `discover()` never
 * requests beyond that regardless of what `ctx.page` asks for. Per-section variant verified
 * live too: `/index-news/{section}` (e.g. `/index-news/nasional`), same `?page=N` pagination,
 * same hard cap. **Category HUB root pages' own `?page=N` is a DIFFERENT, verified-live-
 * INEFFECTIVE pagination** (per task brief) — `https://www.tribunnews.com/internasional?page=2`
 * was verified live to render the exact same "Rekomendasi untuk Anda" widget content page 1
 * shows, not real page-2 items; this adapter therefore NEVER builds `?page=` URLs against a
 * bare `/{section}` hub, only against `/index-news` or `/index-news/{section}`.
 *
 * Discovery, secondary — **per-section `sitemap-news.xml`**, NOT RSS. RSS was the task brief's
 * suggested secondary ("RSS/sitemap") and was the first cut here too — `https://
 * www.tribunnews.com/rss` IS a well-formed RSS 2.0 document, but deeper live verification
 * (2026-07-24, sampling 20+ consecutive `<item>` entries across repeated fetches) found EVERY
 * single item's `<link>` (and `<guid>`) is just the bare homepage URL (`https://
 * www.tribunnews.com/`), never the article's real permalink — the feed is genuinely broken for
 * discovery purposes on the live site today, not a parser bug on this end (confirmed by
 * regexing the raw XML bytes directly, bypassing this adapter's own parsing entirely). Per the
 * task brief's own "RSS/sitemap" either-or framing, this adapter uses the sitemap instead:
 * `https://www.tribunnews.com/sitemap.xml` is a `sitemapindex` (verified live) of per-section
 * `{section}/sitemap-news.xml|-web.xml|-images.xml`; `-news.xml` (verified live, e.g. `https://
 * www.tribunnews.com/nasional/sitemap-news.xml`, ~100 `<url>` entries) is a standard Google
 * News sitemap — `<url><loc>{articleUrl}</loc><news:news><news:publication_date>{ISO 8601 w/
 * +07:00 offset}</news:publication_date><news:title>{title}</news:title>
 * <news:keywords>{comma-separated}</news:keywords></news:news></url>` per entry, every `<loc>`
 * verified a genuine per-article permalink (unlike the RSS `<link>`). This adapter fetches one
 * section's `sitemap-news.xml` directly (default `nasional`, overridable via `ctx.section` —
 * same predictable `{section}/sitemap-news.xml` path, no need to fetch/parse the top-level
 * `sitemapindex` first) rather than RSS's now-confirmed-unusable feed. `parseRssXml()`/
 * `RSS_URL` were removed rather than kept dead — see git history if a future pass wants to
 * revisit RSS once/if Tribunnews fixes its own feed.
 *
 * Article URL shape — **two live-verified, both valid, shapes**:
 *   1. `https://www.tribunnews.com/{section}/{numericId}/{slug}` (the common case, e.g.
 *      `/internasional/7858656/trump-bebankan-kerugian-selat-hormuz-ke-iran-aset-beku-teheran-
 *      siap-dikuras-as`). `{numericId}` is reused as `external_article_id`.
 *   2. `https://www.tribunnews.com/{section}/{yyyy}/{mm}/{dd}/{slug}` (verified live on a wire/
 *      syndicated-style international piece, e.g. `/internasional/2026/07/24/rusia-menjebak-
 *      buruh-migran-agar-bertempur-di-ukraina` — no redirect, `<link rel="canonical">` self-
 *      referential to this exact URL, genuinely different shape from #1, NOT a typo/one-off).
 *      This shape carries NO numeric id in the URL itself — the id is verified live to still
 *      exist as `data-content-id="{id}"` on the share-widget `<div>` and as `<meta
 *      property="android:app_id" content="{id}">`, both read as a DOM/meta fallback for
 *      `external_article_id` (see `extractExternalIdFromDom()`).
 * Both shapes' `{section}` is an open set (verified live across many rubrics: `internasional`,
 * `nasional`, `metropolitan`, `bisnis`, `regional`, `pendidikan`, `lifestyle`, ... — no closed
 * enum is hardcoded, matching the open-`{kanal}` stance every sibling adapter already takes).
 *
 * Article page metadata — **hybrid JSON-LD + DOM**, per the task brief:
 *   - JSON-LD is a `@graph` array (verified live) containing a `NewsArticle` entry (`headline`,
 *     `description`, `datePublished`/`dateModified` — full ISO 8601 WITH an explicit `+07:00`
 *     offset already, no "assume WIB" guessing needed — `author` (an ARRAY of `Person`),
 *     `image.url`, `articleSection` (matches the URL's own `{section}` segment, e.g.
 *     "Internasional"), `keywords` (a flat string array — reused as `tags`, PRIMARY source),
 *     and **`isAccessibleForFree`** (a plain boolean, verified live `true` on every sampled
 *     article — no live Tribunnews paywalled/"Premium" sample was directly observed during this
 *     assessment, but the site's own `sectionpil` category-filter dropdown on `/index-news` DOES
 *     list a `"premium"` option, so the schema field is real infrastructure on this source, not
 *     invented; handled exactly like Tempo's own `isAccessibleForFree` — see `isAccessibleForFree`
 *     note below) plus a `BreadcrumbList` entry (`[Home, {Section}, {Sub-section}]`, e.g.
 *     `[Home, Internasional, Amerika]` — used only as a `category` fallback, since
 *     `articleSection` already matches the URL section and is simpler/more direct).
 *   - Body DOM: `div.side-article.txt-article` (verified live; the compound two-class selector
 *     matters — a DIFFERENT, unrelated `div.side-article.mb5` "Sesuai Minatmu" recommendation
 *     widget sits immediately after the real body in the DOM and does NOT carry the
 *     `txt-article` class, so the compound selector alone excludes it with no extra stripping
 *     needed). Noise stripped before extracting `p`/`h2`/`h3` text (all verified live, present
 *     as distinct wrapper elements): `blockquote.summary-article` (a "Ringkasan Berita:" bullet
 *     recap that duplicates `summary`/`description`, not real body prose), `p.baca` ("Baca
 *     juga: ..." recirculation links), `div.ads-placeholder` (ad slots), `figure`/`figcaption`
 *     (image + caption blocks). A defensive text-regex filter additionally catches any
 *     leftover "Baca juga"/"Ringkasan Berita" line in case a future template stops wrapping
 *     either in its own element (same defense-in-depth spirit as every sibling adapter's own
 *     noise regex).
 *   - **Multipage articles** (verified live, e.g. the Trump/Selat Hormuz sample: page 1 body
 *     ends mid-story, a `<div class="paging">...<span class="total-page">Halaman 1/2</span>
 *     ...<a href="...?page=2" rel="page-2">2</a></div>` widget follows, and `?page=2` returns
 *     the SAME `div.side-article.txt-article` selector with the story's remaining paragraphs,
 *     `og:url`/canonical STILL pointing at the page-1 URL with no `page` param — same shape/
 *     contract as VIVA's own multipage handling, `detectPagination()`/`collectPageHtmls()`
 *     below are adapted directly from `src/adapters/viva/index.js`). `canonical_url` never
 *     carries a `page` param either way (`stripPageParam()`, defensive on every adapter here).
 *   - `author_name` <- JSON-LD `author[].name`, deduplicated (verified live sometimes lists
 *     just one `Person`, same shape Tempo/CNN Indonesia already handle) — DOM fallback `#penulis
 *     a` (verified live, e.g. `<div id="penulis">Penulis: <a href="/penulis/...">{name}</a>
 *     </div>`; NOTE `#editor a` is a DIFFERENT role/person and is deliberately never folded into
 *     `author_name` — there is no dedicated N5 `editor_name` column, so it is simply not
 *     captured, matching the "don't invent new top-level fields" stance every sibling adapter
 *     takes).
 *   - `published_at` <- JSON-LD `datePublished` PRIMARY, DOM `time[datetime]` fallback (verified
 *     live `<time datetime="2026-07-24T12:40+07:00">Jumat, 24 Juli 2026 12:40 WIB</time>` right
 *     next to the "Tayang:" label).
 *   - `tags` <- JSON-LD `keywords` PRIMARY (flat string array, verified live) — DOM fallback
 *     `h5.tagcloud3 a.rd2` (verified live tag-pill widget near the end of the article; anchor
 *     text is the human-readable tag label, no "#"-stripping needed unlike Media Indonesia's
 *     own tag widget).
 *   - `title`/`summary`/`thumbnail_url`/`canonical_url` all have the standard
 *     JSON-LD-then-DOM-then-`og:*`-then-`<title>`/`meta[name=description]` fallback chain every
 *     sibling adapter already uses; see `coreAdapter.js`'s field matrix for the exact per-field
 *     chain and confidence.
 *
 * `isAccessibleForFree`: surfaced (like Tempo's own `isAccessibleForFree`) via `coreAdapter.js`'s
 * `content_text` `field_provenance` confidence, dropping to `"low"` with an explanatory note
 * whenever it is `false` — the extracted `content_text` in that case is documented as a likely
 * teaser, never padded/faked to look like a full body. `fixtures/tribunnews/sample-article-
 * premium.html` exercises this path offline (synthetic — no live paywalled sample was
 * available to fixture, see note above).
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every sibling adapter); otherwise it
 * reads the bundled `fixtures/tribunnews/index-news.html` + `fixtures/tribunnews/sitemap-
 * news.xml` fixtures. `parse()` is fixture-first when no `html` is supplied (or `ctx.fixtureOnly` is
 * set), reading `fixtures/tribunnews/sample-article.html` (or `sample-article-premium.html` /
 * `sample-article-datepattern.html` per `ctx.fixtureVariant`) — fixtures work fully offline
 * regardless of any live CloudFront behavior. `LIVE_UA` (a genuine browser-class product UA
 * string, per the task brief — see header note above, env-overridable via
 * `TRIBUNNEWS_LIVE_UA`) is ONLY ever used for live HTTP; it is never referenced by the fixture
 * path, so registering/testing this adapter never causes surprise network traffic and never
 * needs the override to pass fixtures offline.
 */

const SOURCE_ID = 'tribunnews';
const BASE_URL = 'https://www.tribunnews.com/';
// Secondary discovery channel default section — see module header "Discovery, secondary" for
// why this is `sitemap-news.xml`, not RSS (RSS's own `<link>` was verified live to always be
// the bare homepage, not a real per-article permalink).
const DEFAULT_SITEMAP_SECTION = 'nasional';
// Tight scope per task brief: `www.tribunnews.com` ONLY. Neither the mobile mirror
// (`m.tribunnews.com`) nor any of the ~40 separate regional "Tribun Network" domains (Tribun
// Jabar, Tribun Jogja, Serambi Indonesia, ...) are accepted here — see module header.
const ALLOWED_HOSTS = new Set(['www.tribunnews.com']);

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'tribunnews');
const FIXTURE_INDEX_NEWS_PATH = path.join(FIXTURES_DIR, 'index-news.html');
const FIXTURE_SITEMAP_NEWS_PATH = path.join(FIXTURES_DIR, 'sitemap-news.xml');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');
const FIXTURE_ARTICLE_PAGE2_PATH = path.join(FIXTURES_DIR, 'sample-article-page2.html');
const FIXTURE_ARTICLE_PREMIUM_PATH = path.join(FIXTURES_DIR, 'sample-article-premium.html');
const FIXTURE_ARTICLE_DATEPATTERN_PATH = path.join(FIXTURES_DIR, 'sample-article-datepattern.html');

// This source's live requests deliberately do NOT reuse the shared `CRAWLER_UA` env var/
// convention (`EGIMediaCrawler/0.1`) — that exact string was verified live to get an HTTP 403
// from CloudFront on every path tried (see module header). `TRIBUNNEWS_LIVE_UA` lets ops
// override this per-source (renamed from `TRIBUNNEWS_UA` in Sprint 7 (S7-A) for naming
// consistency with `beritasatu`'s own `BERITASATU_LIVE_UA` and with the shared
// `src/workers/lib/fetchHtml.js` wiring — see docs/RESTRICTED_UA_POLICY.md §4); the default is
// a genuine browser-class product UA STRING (verified live to get HTTP 200) with this crawler's
// own token appended as a suffix — i.e. it is honest about being a bot (never claims to BE
// Chrome), just browser-class enough to satisfy CloudFront's heuristic, and per the task brief
// it is NEVER a spoofed named-bot identity (no "Googlebot"/"bingbot" string anywhere here, even
// though robots.txt would allow those specifically).
const LIVE_UA =
  process.env.TRIBUNNEWS_LIVE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 EGIMediaCrawler/0.1';

const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range
const MAX_MERGED_PAGES = 20; // safety cap so a malformed pagination count can't loop forever

// Per task brief: `/index-news` (and `/index-news/{section}`) pagination is hard-capped at page
// 10 — page 11+ is verified (per brief) to just repeat page 10's content. `discover()` never
// requests beyond this regardless of what `ctx.page` asks for.
const MAX_INDEX_PAGE = 10;

// Article URLs: https://www.tribunnews.com/{section}/{numericId}/{slug} (3 segments, 2nd
// numeric, >=5 digits per every live sample). Slug must contain a letter (defense-in-depth,
// same reasoning sibling adapters apply even though Tribunnews has no known offset-pagination-
// in-path collision risk today).
const ARTICLE_PATH_PATTERN_ID = /^\/([a-z0-9-]+)\/(\d{5,})\/([a-z0-9-]+)\/?$/i;
// Article URLs, alternate shape: https://www.tribunnews.com/{section}/{yyyy}/{mm}/{dd}/{slug}
// (5 segments, verified live on a wire/syndicated piece — see module header). No numeric id in
// the URL itself; `extractExternalIdFromDom()` is the only source for that shape's id.
const ARTICLE_PATH_PATTERN_DATE = /^\/([a-z0-9-]+)\/(\d{4})\/(\d{2})\/(\d{2})\/([a-z0-9-]+)\/?$/;
const SLUG_HAS_LETTER_PATTERN = /[a-z]/i;

// First path segments that are never articles — robots.txt-disallowed prefixes
// (index-news/tag/topic/search/komentar/member/auth/api/ajax/json, per module header) plus a
// few more live-observed non-article routes (author-profile pages, non-text content types).
const NON_ARTICLE_FIRST_SEGMENTS = new Set([
  'index-news',
  'tag',
  'topic',
  'search',
  'komentar',
  'member',
  'auth',
  'api',
  'ajax',
  'json',
  'posts',
  'penulis',
  'editor',
  'epaper',
  'images',
  'webstories',
  'video',
  'foto',
  'rss',
  'sitemap',
  'tribun-network',
  'account',
  'about-us',
  'redaksi',
  'terms',
  'privacy-policy',
  'pedoman-media-siber',
  'contact-us',
  'karir',
  'help',
]);

// Indonesian full month names, as seen live in the `/index-news` listing's `<time class="grey">`
// text ("Jumat, 24 Juli 2026 17:25 WIB") — used only as the discovery-time `published_hint`
// parser; the article page itself prefers JSON-LD `datePublished` (full ISO 8601 already).
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

// "Baca juga: ..." recirculation line and the "Ringkasan Berita:" summary-recap blockquote,
// both verified live wrapped in their own element (`p.baca` / `blockquote.summary-article`) and
// stripped by selector — these text-regex checks are a defensive second layer only, in case a
// future template stops wrapping either in its own element (same posture as every sibling
// adapter's own noise regex, e.g. media_indonesia's `BACA_JUGA_PATTERN`).
const BACA_JUGA_PATTERN = /^baca juga\s*:/i;
const RINGKASAN_BERITA_PATTERN = /^ringkasan berita\s*:?/i;

// Noise elements stripped from a clone of `div.side-article.txt-article` before pulling
// `p`/`h2`/`h3` text — see module header "Body DOM" note for what each one is, live-verified.
const BODY_NOISE_SELECTORS = ['blockquote.summary-article', 'p.baca', '.ads-placeholder', 'figure', 'figcaption', 'script', 'style', 'ins'];

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function isLiveCrawlEnabled() {
  return process.env.CRAWL_LIVE === 'true';
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
    displayName: 'Tribunnews.com',
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

/**
 * @param {string} url
 * @returns {boolean} true for either live-verified article URL shape (see module header
 *   "Article URL shape"), scoped to `ALLOWED_HOSTS` and excluding every known non-article
 *   first path segment.
 */
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
  if (segments.length === 0) {
    return false;
  }
  if (NON_ARTICLE_FIRST_SEGMENTS.has(segments[0].toLowerCase())) {
    return false;
  }

  const idMatch = ARTICLE_PATH_PATTERN_ID.exec(parsed.pathname);
  if (idMatch) {
    return SLUG_HAS_LETTER_PATTERN.test(idMatch[3]);
  }

  const dateMatch = ARTICLE_PATH_PATTERN_DATE.exec(parsed.pathname);
  if (dateMatch) {
    return SLUG_HAS_LETTER_PATTERN.test(dateMatch[5]);
  }

  return false;
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url` (multipage
 * articles' own canonical/`og:url` never carries it live either — see module header).
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

function buildPageUrl(canonicalUrl, pageNumber) {
  try {
    const parsed = new URL(canonicalUrl);
    parsed.searchParams.set('page', String(pageNumber));
    return parsed.toString();
  } catch (_err) {
    return `${canonicalUrl}${canonicalUrl.includes('?') ? '&' : '?'}page=${pageNumber}`;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the `{section}` first path segment, used as a discovery-time
 *   category hint and as `category`'s final URL-based fallback.
 */
function extractSectionFromUrl(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[0] || undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the numeric `{numericId}` segment, ONLY for the
 *   `/{section}/{numericId}/{slug}` shape — the date-pattern shape has no id in the URL at all
 *   (see `extractExternalIdFromDom()` for that shape's only id source).
 */
function extractExternalIdFromUrl(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const match = ARTICLE_PATH_PATTERN_ID.exec(new URL(url).pathname);
    return match ? match[2] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * DOM/meta fallback for `external_article_id`, needed for the date-pattern URL shape (verified
 * live: `data-content-id="{id}"` on the share-widget `<div>`, and the same id as `<meta
 * property="android:app_id" content="{id}">` — both checked, either can be missing/stale).
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined}
 */
function extractExternalIdFromDom($) {
  const dataId = $('[data-content-id]').first().attr('data-content-id');
  if (dataId && /^\d+$/.test(dataId)) return dataId;
  const appId = $('meta[property="android:app_id"]').attr('content');
  if (appId && /^\d+$/.test(appId)) return appId;
  return undefined;
}

/**
 * @param {{section?: string, page?: number}} [opts] - `page` is clamped to
 *   `[1, MAX_INDEX_PAGE]` per module header ("page 11+ repeats page 10").
 * @returns {string}
 */
function buildIndexNewsUrl({ section, page } = {}) {
  const basePath = section ? `index-news/${section}` : 'index-news';
  const url = `${BASE_URL}${basePath}`;
  if (!Number.isInteger(page) || page <= 1) {
    return url;
  }
  const clampedPage = Math.min(page, MAX_INDEX_PAGE);
  return `${url}?page=${clampedPage}`;
}

/**
 * @param {string} text - e.g. "Jumat, 24 Juli 2026 17:25 WIB" (verified live `/index-news`
 *   listing date format — weekday name, day, full Indonesian month name, year, "HH:mm", "WIB").
 * @returns {string|undefined} ISO 8601 string, assuming `+07:00` (WIB, same "no-tz means WIB"
 *   convention used across this repo).
 */
function parseIndonesianDateTime(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX_ID[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Parses an `/index-news` (or `/index-news/{section}`) listing page into discovery entries.
 * Card markup verified live: `ul.lsi > li` each with `<time class="grey">{date}</time>` +
 * `<h3 class="f16 fbo"><a href=... title=...>{title}</a></h3>`; some items ALSO carry a
 * `<h4 class="red ..."><a href="/topic/...">{topic}</a></h4>` immediately before the `h3` — that
 * h4/topic anchor is deliberately never selected here (its href is a `/topic/` listing page,
 * not an article, and would otherwise slip past `isArticleUrl()`'s own `/topic/` exclusion only
 * by accident of selector choice, not by design).
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, normalizedUrl?: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function parseIndexNewsHtml(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('ul.lsi > li').each((_, el) => {
    if (items.length >= limit) return;
    const $li = $(el);
    const $link = $li.find('h3 a').first();
    const href = $link.attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    items.push({
      rawUrl: href,
      normalizedUrl: stripPageParam(href),
      listingTitle: $link.text().trim() || undefined,
      publishedHint: parseIndonesianDateTime($li.find('time').first().text().trim()),
      categoryHint: extractSectionFromUrl(href),
      externalId: extractExternalIdFromUrl(href),
    });
  });

  return items.slice(0, limit);
}

/**
 * @param {string} [section] - defaults to `DEFAULT_SITEMAP_SECTION`; same predictable
 *   `{section}/sitemap-news.xml` path the top-level `sitemapindex` itself lists (verified
 *   live), fetched directly without needing the indirection through the index first.
 * @returns {string}
 */
function buildSitemapNewsUrl(section) {
  return `${BASE_URL}${section || DEFAULT_SITEMAP_SECTION}/sitemap-news.xml`;
}

/**
 * Parses a per-section Google-News-style `sitemap-news.xml` (verified live shape — see module
 * header "Discovery, secondary" — this REPLACED an initial RSS-based cut once RSS's own
 * `<link>` was verified live to always be the bare homepage, never a real per-article
 * permalink) into discovery entries. Structure: `<url><loc>{articleUrl}</loc><news:news>
 * <news:publication_date>{ISO 8601}</news:publication_date><news:title>{title}</news:title>
 * <news:keywords>{comma-separated}</news:keywords></news:news></url>` per entry.
 * @param {string} xml
 * @param {number} limit
 * @returns {Array<{rawUrl: string, normalizedUrl?: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function parseSitemapNewsXml(xml, limit) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  const seen = new Set();

  $('url').each((_, el) => {
    if (items.length >= limit) return;
    const $url = $(el);
    const loc = $url.find('loc').first().text().trim();
    if (!loc || seen.has(loc) || !isArticleUrl(loc)) return;
    seen.add(loc);

    items.push({
      rawUrl: loc,
      normalizedUrl: stripPageParam(loc),
      listingTitle: $url.find('news\\:title').first().text().trim() || undefined,
      publishedHint: toIsoOrUndefined($url.find('news\\:publication_date').first().text().trim()),
      categoryHint: extractSectionFromUrl(loc),
      externalId: extractExternalIdFromUrl(loc),
    });
  });

  return items.slice(0, limit);
}

/**
 * Fetches one page over HTTP using `LIVE_UA` (see module header — deliberately NOT the shared
 * `CRAWLER_UA`), returning `undefined` on any non-2xx/network failure (never throws) so callers
 * can fall back to the bundled fixture.
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
 * primary `/index-news` (or `/index-news/{section}`) HTML listing and the secondary per-section
 * `sitemap-news.xml` (NOT RSS — see module header on why). Each channel independently falls
 * back to its own bundled fixture on a live failure/empty result, and the union is deduped
 * before honoring `ctx.limit`.
 * @param {{limit?: number, channelUrl?: string, section?: string, page?: number,
 *   logger?: {warn?: Function}, liveDiscover?: boolean}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const logger = ctx.logger || console;
  const live = isLiveDiscoverEnabled(ctx);

  const indexNewsUrl = ctx.channelUrl || buildIndexNewsUrl({ section: ctx.section, page: ctx.page });

  let indexHtml;
  let indexChannelTag = 'index_news';
  if (live) {
    indexHtml = await fetchLivePage(indexNewsUrl);
    if (!indexHtml && typeof logger.warn === 'function') {
      logger.warn('[tribunnews] discover(): live /index-news fetch failed; falling back to fixture');
    }
  }
  if (!indexHtml) {
    indexHtml = readFixture(FIXTURE_INDEX_NEWS_PATH);
    indexChannelTag = live ? 'index_news:fixture_fallback' : 'index_news:fixture';
  }
  const indexItems = parseIndexNewsHtml(indexHtml, limit).map((item) => ({ ...item, discoveryChannel: indexChannelTag }));

  const sitemapNewsUrl = buildSitemapNewsUrl(ctx.sitemapSection || ctx.section);
  let sitemapXml;
  let sitemapChannelTag = 'sitemap_news';
  if (live) {
    sitemapXml = await fetchLivePage(sitemapNewsUrl);
    if (!sitemapXml && typeof logger.warn === 'function') {
      logger.warn('[tribunnews] discover(): live sitemap-news fetch failed; falling back to fixture');
    }
  }
  if (!sitemapXml) {
    sitemapXml = readFixture(FIXTURE_SITEMAP_NEWS_PATH);
    sitemapChannelTag = live ? 'sitemap_news:fixture_fallback' : 'sitemap_news:fixture';
  }

  let sitemapItems = [];
  try {
    sitemapItems = parseSitemapNewsXml(sitemapXml, limit).map((item) => ({ ...item, discoveryChannel: sitemapChannelTag }));
  } catch (_err) {
    sitemapItems = []; // best-effort secondary channel — never blocks the primary one.
  }

  // Interleave (round-robin) rather than concatenate-then-slice: `parseIndexNewsHtml`/
  // `parseSitemapNewsXml` are each independently capped at `limit`, and the primary channel
  // alone regularly has >= `limit` items on a busy news day — a naive primary-then-secondary
  // concatenation would then let the final `slice(0, limit)` silently starve the secondary
  // channel every single run. Alternating guarantees both channels can surface within a small
  // `ctx.limit`, while still preferring the primary channel's ordering on ties.
  const merged = [];
  const seen = new Set();
  const maxLen = Math.max(indexItems.length, sitemapItems.length);
  for (let i = 0; i < maxLen && merged.length < limit; i += 1) {
    for (const list of [indexItems, sitemapItems]) {
      if (merged.length >= limit) break;
      const item = list[i];
      if (!item || seen.has(item.rawUrl)) continue;
      seen.add(item.rawUrl);
      merged.push(item);
    }
  }

  return { items: merged.slice(0, limit) };
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

/**
 * Tribunnews's JSON-LD is a single `@graph` array (verified live) carrying both the
 * `NewsArticle` entry and a separate `BreadcrumbList` entry — `parseJsonLdBlock()` flattens
 * `@graph` transparently so this works the same as a sibling adapter's flat block list.
 * @param {cheerio.CheerioAPI} $
 * @returns {object[]}
 */
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
 * @param {Object|Object[]|undefined} author - JSON-LD `NewsArticle.author` (verified live to
 *   be an ARRAY of `Person`). Deduplicated (case-insensitive) and joined with ", ".
 * @returns {string|undefined}
 */
function extractAuthorNames(author) {
  const list = Array.isArray(author) ? author : author ? [author] : [];
  const seen = new Set();
  const names = [];
  for (const entry of list) {
    const name = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names.length > 0 ? names.join(', ') : undefined;
}

/**
 * DOM fallback for author: `#penulis a` (verified live — see module header). `#editor a` is a
 * DIFFERENT role/person and is deliberately never read here (no N5 field exists for it).
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined}
 */
function extractAuthorFromDom($) {
  const name = $('#penulis a').first().text().trim();
  return name || undefined;
}

/**
 * @param {Object|undefined} breadcrumbLd
 * @returns {string[]} breadcrumb labels in order, e.g. ["Home", "Internasional", "Amerika"]
 *   (verified live `BreadcrumbList` shape — see module header).
 */
function extractBreadcrumbLabels(breadcrumbLd) {
  const items = breadcrumbLd && Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  return items.map((entry) => entry && entry.name).filter((name) => typeof name === 'string' && name.length > 0);
}

/**
 * @param {string[]} breadcrumbLabels
 * @returns {string|undefined} the most specific (last) breadcrumb label, excluding "Home".
 */
function extractCategoryFromBreadcrumb(breadcrumbLabels) {
  const withoutHome = breadcrumbLabels.filter((label) => label.toLowerCase() !== 'home');
  return withoutHome.length > 0 ? withoutHome[withoutHome.length - 1] : undefined;
}

/**
 * @param {unknown} keywords - JSON-LD `NewsArticle.keywords` (verified live: a flat string
 *   array; defensively also accepts a comma-separated string in case of a future template
 *   change).
 * @returns {string[]}
 */
function extractTagsFromJsonLd(keywords) {
  if (Array.isArray(keywords)) {
    return keywords.map((k) => String(k).trim()).filter(Boolean);
  }
  if (typeof keywords === 'string' && keywords) {
    return keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * DOM fallback for tags: `h5.tagcloud3 a.rd2` (verified live tag-pill widget — see module
 * header). Unlike Media Indonesia's own tag widget, anchor text here has no leading "#" marker
 * to strip.
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractTagsFromDom($) {
  const seen = new Set();
  const tags = [];
  $('h5.tagcloud3 a.rd2').each((_, el) => {
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
 * Reads the `div.paging` pagination widget (verified live — see module header "Multipage
 * articles") to determine how many pages this article spans, plus an explicit href-per-page
 * map (preferred over blindly assuming `?page=N` works the same way `buildPageUrl()` guesses).
 * @param {cheerio.CheerioAPI} $
 * @returns {{totalPages: number, pageUrls: Map<number, string>}}
 */
function detectPagination($) {
  const totalPageText = $('.paging .total-page').first().text().trim(); // e.g. "Halaman 1/2"
  const match = /Halaman\s*\d+\s*\/\s*(\d+)/i.exec(totalPageText);
  const parsedTotal = match ? parseInt(match[1], 10) : 1;
  const totalPages = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : 1;

  const pageUrls = new Map();
  $('.paging a[rel^="page-"]').each((_, el) => {
    const relMatch = /page-(\d+)/.exec($(el).attr('rel') || '');
    const href = $(el).attr('href');
    if (relMatch && href) {
      pageUrls.set(parseInt(relMatch[1], 10), href);
    }
  });

  return { totalPages: Math.min(totalPages, MAX_MERGED_PAGES), pageUrls };
}

/**
 * Live-mode helper: fetches one additional article page over HTTP. Only ever called when
 * `process.env.CRAWL_LIVE === 'true'` (see `collectPageHtmls`), so registering/testing this
 * adapter offline never triggers it.
 * @param {string} pageUrl
 * @returns {Promise<string|undefined>}
 */
async function fetchLiveArticlePage(pageUrl) {
  return fetchLivePage(pageUrl);
}

/**
 * Collects the HTML for every page of a (possibly multipage) article, merging page 1
 * (already-fetched `firstPageHtml`) with pages 2..N. Adapted directly from
 * `src/adapters/viva/index.js`'s `collectPageHtmls()` — same resolution order:
 *   1. `ctx.fetchPage(pageUrl, pageNumber)` — injected by tests/callers (offline-safe).
 *   2. The bundled page-2 fixture, IF the first page itself came from the bundled fixture.
 *   3. Live HTTP via `LIVE_UA`, IF `CRAWL_LIVE=true`.
 *   4. Otherwise: give up gracefully and merge only page 1.
 * @param {string} firstPageHtml
 * @param {string} canonicalUrl
 * @param {Object} [ctx]
 * @returns {Promise<string[]>}
 */
async function collectPageHtmls(firstPageHtml, canonicalUrl, ctx) {
  const $ = cheerio.load(firstPageHtml);
  const { totalPages, pageUrls } = detectPagination($);
  const pages = [firstPageHtml];

  if (totalPages <= 1) return pages;

  const isFixtureFirstPage = firstPageHtml === readFixtureSafe(FIXTURE_ARTICLE_PATH);
  const fetchPage = (ctx && typeof ctx.fetchPage === 'function' && ctx.fetchPage) || undefined;

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    const pageUrl = pageUrls.get(pageNumber) || buildPageUrl(canonicalUrl, pageNumber);
    let pageHtml;

    try {
      if (fetchPage) {
        pageHtml = await fetchPage(pageUrl, pageNumber);
      } else if (isFixtureFirstPage && pageNumber === 2) {
        pageHtml = readFixtureSafe(FIXTURE_ARTICLE_PAGE2_PATH);
      } else if (isLiveCrawlEnabled()) {
        pageHtml = await fetchLiveArticlePage(pageUrl);
      }
    } catch (_err) {
      pageHtml = undefined;
    }

    if (!pageHtml) break; // non-fatal: ship whatever pages we already merged
    pages.push(pageHtml);
  }

  return pages;
}

/**
 * Extracts `div.side-article.txt-article` text (verified live selector — see module header
 * "Body DOM" note on why the compound two-class selector matters), after stripping known noise
 * elements, returning `p`/`h2`/`h3` text in document order.
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractBodyParagraphs($) {
  const bodyEl = $('div.side-article.txt-article').first();
  if (!bodyEl || bodyEl.length === 0) return [];

  const cleaned = bodyEl.clone();
  cleaned.find(BODY_NOISE_SELECTORS.join(', ')).remove();

  return cleaned
    .find('p, h2, h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0 && !BACA_JUGA_PATTERN.test(text) && !RINGKASAN_BERITA_PATTERN.test(text));
}

/**
 * @param {string|undefined} html
 * @returns {string} the resolved page-1 HTML — fetched, or one of the three bundled fixtures
 *   selected by `ctx.fixtureVariant`.
 */
function resolveFirstPageHtml(html, ctx) {
  if (typeof html === 'string' && html.length > 0 && !(ctx && ctx.fixtureOnly)) {
    return html;
  }
  const variant = ctx && ctx.fixtureVariant;
  if (variant === 'premium') return readFixture(FIXTURE_ARTICLE_PREMIUM_PATH);
  if (variant === 'datepattern') return readFixture(FIXTURE_ARTICLE_DATEPATTERN_PATH);
  return readFixture(FIXTURE_ARTICLE_PATH);
}

/**
 * @param {string} html - page-1 HTML (fetched or fixture).
 * @param {{url?: string, fixtureOnly?: boolean, fixtureVariant?: 'premium'|'datepattern', fetchPage?: Function}} [ctx]
 * @returns {Promise<Object>} raw ParsedArticle-like draft (camelCase); see coreAdapter.js for
 *   the mapping to the core snake_case shape + the field-provenance matrix.
 */
async function parse(html, ctx) {
  const firstPageHtml = resolveFirstPageHtml(html, ctx);
  const $ = cheerio.load(firstPageHtml);

  const ldBlocks = extractJsonLdBlocks($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};
  const breadcrumbLd = findBreadcrumbLd(ldBlocks);

  const canonicalUrlRaw =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && (articleLd.mainEntityOfPage['@id'] || articleLd.mainEntityOfPage.url)) ||
    (ctx && ctx.url);
  const canonicalUrl = canonicalUrlRaw ? stripPageParam(canonicalUrlRaw) : undefined;

  const url = (ctx && ctx.url) || canonicalUrl;

  const title =
    articleLd.headline ||
    $('h1#arttitle').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.replace(/\s*-\s*Tribunnews\.com\s*$/i, '') ||
    $('title').text().trim();

  const author = extractAuthorNames(articleLd.author) || extractAuthorFromDom($);

  const publishedAt = toIsoOrUndefined(articleLd.datePublished) || toIsoOrUndefined($('time[datetime]').first().attr('datetime'));
  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const summaryRaw =
    articleLd.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;
  // Defensive: page-2+ variants of the same meta tag are verified live to carry a trailing
  // " - Halaman N" suffix (Tribunnews appends it to the SEO description on paginated pages) —
  // stripped so a multipage article's summary is identical regardless of which page happened
  // to be passed to parse().
  const summary = summaryRaw ? summaryRaw.replace(/\s*-\s*Halaman\s*\d+\s*$/i, '') : undefined;

  const jsonLdImage = articleLd.image && (typeof articleLd.image === 'string' ? articleLd.image : articleLd.image.url);
  const thumbnailUrl = jsonLdImage || $('meta[property="og:image"]').attr('content') || undefined;

  const isAccessibleForFree = typeof articleLd.isAccessibleForFree === 'boolean' ? articleLd.isAccessibleForFree : undefined;

  const breadcrumbLabels = extractBreadcrumbLabels(breadcrumbLd);
  const category = articleLd.articleSection || extractCategoryFromBreadcrumb(breadcrumbLabels) || extractSectionFromUrl(url);

  const jsonLdTags = extractTagsFromJsonLd(articleLd.keywords);
  const tags = jsonLdTags.length > 0 ? jsonLdTags : extractTagsFromDom($);

  const externalArticleId = extractExternalIdFromUrl(url) || extractExternalIdFromDom($) || undefined;

  const pageHtmls = canonicalUrl ? await collectPageHtmls(firstPageHtml, canonicalUrl, ctx) : [firstPageHtml];
  const paragraphs = pageHtmls.flatMap((pageHtml, index) => {
    const $page = index === 0 ? $ : cheerio.load(pageHtml);
    return extractBodyParagraphs($page);
  });

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
    pagesMerged: pageHtmls.length,
    isAccessibleForFree,
    rawHtml: firstPageHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/tribunnews/smoke-test.js) and for
  // debugging extraction logic in isolation.
  isInScope,
  extractExternalIdFromUrl,
  extractExternalIdFromDom,
  extractSectionFromUrl,
  buildIndexNewsUrl,
  parseIndexNewsHtml,
  buildSitemapNewsUrl,
  parseSitemapNewsXml,
  parseIndonesianDateTime,
  extractJsonLdBlocks,
  findNewsArticleLd,
  findBreadcrumbLd,
  extractAuthorNames,
  extractAuthorFromDom,
  extractBreadcrumbLabels,
  extractCategoryFromBreadcrumb,
  extractTagsFromJsonLd,
  extractTagsFromDom,
  detectPagination,
  extractBodyParagraphs,
  stripPageParam,
  discoverLive: async (ctx) => discover({ ...ctx, liveDiscover: true }),
  isLiveDiscoverEnabled,
  isLiveCrawlEnabled,
  MAX_INDEX_PAGE,
  LIVE_UA,
  FIXTURE_INDEX_NEWS_PATH,
  FIXTURE_SITEMAP_NEWS_PATH,
  FIXTURE_ARTICLE_PATH,
  FIXTURE_ARTICLE_PAGE2_PATH,
  FIXTURE_ARTICLE_PREMIUM_PATH,
  FIXTURE_ARTICLE_DATEPATTERN_PATH,
};
