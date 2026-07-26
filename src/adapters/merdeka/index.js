'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Merdeka.com (www.merdeka.com) adapter — Sprint 6b (S6b-A). camelCase raw adapter, following
 * the same fixture-first pattern as `src/adapters/idn_times/index.js` / `src/adapters/suara/
 * index.js`. `./coreAdapter.js` bridges this to the snake_case `ParsedArticle` shape `src/core`
 * (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct HTTP fetches —
 * PowerShell `Invoke-WebRequest` with a desktop-browser User-Agent, against
 * `www.merdeka.com` directly and its own live `robots.txt`):
 *
 *  - **robots.txt** (fetched live): disallows `/ucnews/`, `/search/*` (wildcard path), any
 *    path containing the literal segment "index" wrapped in wildcards, any path ending in a
 *    bare "?", and — critically — a bare wildcard-question-mark rule banning ANY URL carrying
 *    a query string at all, plus `*comment*`, `?source=*`, `?mvk_page*`, `?param_mvk*`. This
 *    adapter never constructs or fetches a query-string-bearing URL for discovery, and
 *    `stripQueryString()` defensively strips any query string before treating a URL as a
 *    normalized/canonical identity (a listing/sitemap entry could theoretically carry a
 *    tracking param even though this adapter itself never adds one).
 *    `Sitemap: https://www.merdeka.com/sitemap.xml` is advertised and used as the secondary
 *    discovery channel (see below).
 *  - **No global `/indeks`** — per task brief there is no sitewide article index; discovery
 *    instead uses per-section category hub paths (verified live 200 OK, canonical/`og:url`
 *    both bare, no trailing slash: `https://www.merdeka.com/peristiwa`, `/politik`, `/uang`,
 *    `/dunia`, ... — `DEFAULT_SECTION` is `peristiwa`, overridable via `ctx.category`/
 *    `ctx.section`). Each hub's own pagination (verified live, `pagination__link` hrefs are
 *    literal `?page=2`, `?page=3`, ...) is robots-disallowed by the blanket `/*?` rule above,
 *    so `discoverLive()` only ever fetches page 1 of a given hub — same residual limitation
 *    idn_times documents for its own single-hub-page discovery.
 *  - **Sitemap secondary channel** (verified live): `https://www.merdeka.com/sitemap.xml` is a
 *    sitemap INDEX of ~35 per-SECTION sub-sitemaps (`https://www.merdeka.com/{section}/
 *    sitemap.xml`, e.g. `/peristiwa/sitemap.xml`), each a Google News sitemap whose `<url>`
 *    entries carry a real tz-explicit `news:publication_date`, a `news:title`, and a
 *    `news:keywords` JSON-array-encoded string — richer than the hub listing's own `<time
 *    datetime="">` (verified live to ALWAYS be an empty string on the hub's main
 *    `article__item` feed, see `extractHubItems()` doc). `discoverLive()` fetches BOTH the hub
 *    (primary, freshest/most-relevant ordering) and that section's sitemap (secondary,
 *    supplies `published_hint`/`title_hint` and can surface older items the hub's first page
 *    doesn't), de-duplicating by normalized URL.
 *  - **Article URL shape** (verified live across many samples, every section):
 *      `https://www.merdeka.com/{section}/read/{numericId}/{slug}`
 *    e.g. `.../peristiwa/read/8253998/perintah-dirjen-imigrasi-soal-event-lari-bule-...`. Always
 *    EXACTLY 4 path segments, 2nd segment literally `read`, 3rd segment a bare integer.
 *    `NON_TEXT_FIRST_SEGMENTS` defensively excludes a few sections verified live to share this
 *    EXACT same 4-segment `/read/{id}/{slug}` shape but serve a different (non `.articles-
 *    content__body` prose) template — `foto` (photo galleries, verified live
 *    `/foto/read/8253682/...` exists in the `foto` sitemap) and, by the same site-wide
 *    templating convention, `video`/`slideshow` — none of these are handled by this v1
 *    adapter (documented residual limitation, matches idn_times's own "hyperlocal subdomains
 *    out of scope" treatment).
 *  - **`external_article_id` is the bare numeric id** parsed out of the URL's `/read/{id}/`
 *    segment (verified live, stable and unique site-wide — matches the `data-article-id`
 *    attribute repeated on every listing card for the same article).
 *  - Article page is JSON-LD-strong (`NewsArticle` + `BreadcrumbList` in one `#rich-card`
 *    `<script type="application/ld+json">` array, verified live) PLUS a same-shape set of
 *    `<meta property="article:published_time">`/`article:modified_time"` tags AND an inline
 *    `window.kly = {...}` state object (verified live to be a well-formed JSON object literal
 *    assigned to a global, not a JS expression with function calls) carrying redundant
 *    `channel.name`/`category.name`/`article.reporters` fields — a genuine "hybrid JSON-LD/
 *    meta + body DOM" source per the task brief.
 *  - **`NewsArticle.author[0].name` is verified live to be the JSON literal `null`** — never
 *    usable as `author_name`. The real byline lives in `meta[name="author"]` (verified live,
 *    always populated with the reporter's name, matching `window.kly.article.reporters`) and,
 *    redundantly, the DOM `[data-tracking="author_name"]` anchor text inside the "Oleh ..."
 *    author-section widget.
 *  - **The `BreadcrumbList` JSON-LD is USELESS for `category`**: verified live its 3rd/last
 *    `ListItem` is the ARTICLE'S OWN TITLE, not a subcategory (`Home` > `News` (channel) >
 *    `{article title}`). The real subcategory ("Regional", "Nasional", "News", ... — matches
 *    the `data-category` attribute repeated on listing cards) instead comes from the DOM
 *    `nav.breadcrumb-navigation`'s last breadcrumb item, which for the CURRENT page is a plain
 *    `<span>` (not an `<a>`, verified live) sibling of the `Home`/`News` `<a>` items —
 *    `extractCategoryFromDom()` reads that last `<li>`'s text regardless of whether it's a link
 *    or a span. `window.kly.category.name` carries the same value and is used as a last-resort
 *    fallback if the breadcrumb DOM is ever absent.
 *  - **Multipage articles are served fully pre-merged in a single fetch — NO extra network I/O
 *    is ever needed**: verified live on a real `window.kly.article.isMultipage: true,
 *    multiplePageCount: 4` article — fetching the bare canonical URL (no `?page=N`) already
 *    returns ALL 4 pages' paragraphs inline inside ONE `.articles-content__body` wrapper,
 *    separated only by cosmetic `<div class="page-break" data-page="N"></div>` markers and an
 *    ad-slot placeholder between each page (a `?page=N` variant of the URL also exists,
 *    verified live, showing just that one page — but is never used since the merged version is
 *    strictly more complete and avoids 3 extra requests + the robots-disallowed `?` query
 *    string entirely). This is a materially different (better) situation than most other
 *    multipage adapters in this codebase (e.g. `suara`, which DOES need extra per-page
 *    fetches) — documented here since it's easy to wrongly assume multipage always means
 *    extra I/O.
 *  - **Body paragraphs**: `.articles-content__body > p` (DIRECT children only, verified live).
 *    An `.advertisement-placeholder` ad slot (`div#div-gpt-ad-merdeka-sc-paging-placeholder`,
 *    verified live between every inlined page) is itself a direct child of the body wrapper
 *    too, but nests its own `<p>Advertisement</p>` two levels deep (inside a
 *    `.advertisement-text` div) — the direct-child-only selector excludes it for free, no
 *    separate denylist selector needed. A "Baca Juga" (related-link) box (verified live,
 *    `.bg-primary-50` direct-child `<div>`) contains no `<p>` at all either, so it's excluded
 *    the same way. In-body `/tag/...` mention links (verified live, e.g. linking a keyword
 *    mention to its own tag page) are kept as plain text (cheerio `.text()` already flattens
 *    them) so they never corrupt paragraph boundaries.
 *  - **Tags**: `.tags-articles__list a` (verified live, near the bottom of the article,
 *    `data-tracking="related_tag"`) is the real tag source and (verified live) matches
 *    `meta[name="keywords"]`'s comma-separated list exactly — the meta tag is kept as a
 *    fallback for defensiveness (e.g. if that DOM widget is ever A/B-tested away) and JSON-LD
 *    `keywords` (a plain comma-separated STRING here, not an array like idn_times) as a final
 *    fallback.
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every sibling adapter); otherwise it
 * returns the bundled fixture listing (hub fixture + sitemap fixture, merged the same way the
 * live path does). `parse()` is fixture-first when no `html` is supplied (or `ctx.fixtureOnly`
 * is set), reading `fixtures/merdeka/sample-article.html`. Registered into
 * `src/adapters/index.js`'s ADAPTER_MODULES map by S6b-D.
 */

const SOURCE_ID = 'merdeka';
const BASE_URL = 'https://www.merdeka.com/';
const ALLOWED_HOST = 'www.merdeka.com';
const DEFAULT_SECTION = 'peristiwa';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'merdeka');
const FIXTURE_LISTING_PATH = path.join(FIXTURES_DIR, 'listing-peristiwa.html');
const FIXTURE_SITEMAP_PATH = path.join(FIXTURES_DIR, 'sitemap-peristiwa.xml');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range

// Article URLs: https://www.merdeka.com/{section}/read/{numericId}/{slug} — exactly 4 path
// segments, 2nd segment literally "read", 3rd segment a bare integer (verified live, see
// module header "Article URL shape").
const ARTICLE_PATH_PATTERN = /^\/[a-z0-9-]+\/read\/\d+\/[a-z0-9-]+\/?$/i;

// Sections verified (or, for video/slideshow, inferred by the same site-wide templating
// convention) live to share the exact `/​{section}/read/{id}/{slug}` shape but serve a
// different, non-prose template — out of scope for this v1 text-article adapter (see module
// header "Article URL shape").
const NON_TEXT_FIRST_SEGMENTS = new Set(['foto', 'video', 'slideshow']);

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Merdeka.com',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 30,
    overlapHours: 4,
    enabled: true,
  };
}

/**
 * @param {string} url
 * @returns {boolean} true iff `url`'s hostname is exactly `www.merdeka.com` (case-insensitive).
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
  if (!ARTICLE_PATH_PATTERN.test(parsed.pathname)) {
    return false;
  }
  const firstSegment = parsed.pathname.split('/').filter(Boolean)[0];
  return !NON_TEXT_FIRST_SEGMENTS.has(firstSegment.toLowerCase());
}

/**
 * Strips the ENTIRE query string before using a URL as a normalized/canonical identity.
 * robots.txt disallows crawling ANY `?`-bearing URL outright (`Disallow: /*?`, see module
 * header), so this adapter never fetches such a URL itself, but a listing/sitemap entry could
 * still carry one (e.g. a `?show=all` multipage variant, verified live to exist alongside the
 * already-fully-merged canonical URL — see module header "Multipage articles" note on why that
 * variant is never preferred anyway).
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function stripQueryString(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch (_err) {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} bare numeric id parsed from the URL's `/read/{id}/` segment
 *   (verified live, stable/unique site-wide — see module header "external_article_id" note).
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const match = /\/read\/(\d+)(?:\/|$)/.exec(new URL(url).pathname);
    return match ? match[1] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {{section?: string}} [opts]
 * @returns {string} `https://www.merdeka.com/{section}` — a bare, query-string-free category
 *   hub path (robots-compliant, see module header "No global /indeks" note). Defaults to
 *   `peristiwa`.
 */
function buildCategoryUrl({ section = DEFAULT_SECTION } = {}) {
  return `${BASE_URL}${section}`;
}

/**
 * @param {{section?: string}} [opts]
 * @returns {string} `https://www.merdeka.com/{section}/sitemap.xml` — the secondary discovery
 *   channel (see module header "Sitemap secondary channel" note). Defaults to `peristiwa`.
 */
function buildSitemapUrl({ section = DEFAULT_SECTION } = {}) {
  return `${BASE_URL}${section}/sitemap.xml`;
}

/**
 * Extracts up to `limit` unique in-scope article entries (in document order) from a category
 * hub listing page's main "latest in this channel" feed — `li.article__item[data-article-id]`
 * (verified live on `/peristiwa` — see module header "Article URL shape"/"Body paragraphs"
 * sibling notes and `fixtures/merdeka/listing-peristiwa.html`'s header comment). Deliberately
 * NOT `.news-grid__list__item` or `.tags-popular__item` — both verified live to be smaller
 * "trending"/"popular" widgets that reuse the SAME `data-article-id`s as (a subset of) this
 * main feed, so selecting them too would just re-surface duplicates, not new candidates.
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, externalId?: string, categoryHint?: string}>}
 */
function extractHubItems(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('li.article__item[data-article-id]').each((_, el) => {
    if (items.length >= limit) return;
    const $item = $(el);
    const $anchor = $item.find('a.article__title').first();
    const href = $anchor.attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    items.push({
      rawUrl: href,
      listingTitle: $anchor.text().trim() || undefined,
      externalId: $item.attr('data-article-id') || extractExternalId(href),
      categoryHint: $item.attr('data-category') || undefined,
    });
  });

  return items.slice(0, limit);
}

/**
 * Parses a Google News per-section sitemap (verified live shape — see module header "Sitemap
 * secondary channel" note and `fixtures/merdeka/sitemap-peristiwa.xml`'s header comment) into
 * discovery entries. `news:keywords` is a JSON-array-ENCODED string (verified live, e.g.
 * `["kw1","kw2"]` inside the CDATA block, not a bare comma list) — parsed defensively, falling
 * back to an empty tag list if it's ever malformed.
 * @param {string} xml
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, externalId?: string, tagsHint?: string[]}>}
 */
function extractSitemapItems(xml, limit) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  const seen = new Set();

  $('url').each((_, el) => {
    if (items.length >= limit) return;
    const $url = $(el);
    const loc = $url.find('loc').first().text().trim();
    if (!loc || seen.has(loc) || !isArticleUrl(loc)) return;
    seen.add(loc);

    const publishedRaw = $url.find('news\\:publication_date').first().text().trim();
    const publishedHint = publishedRaw && !Number.isNaN(new Date(publishedRaw).getTime()) ? new Date(publishedRaw).toISOString() : undefined;

    let tagsHint;
    const keywordsRaw = $url.find('news\\:keywords').first().text().trim();
    if (keywordsRaw) {
      try {
        const parsed = JSON.parse(keywordsRaw);
        if (Array.isArray(parsed)) {
          tagsHint = parsed.filter((kw) => typeof kw === 'string' && kw.trim().length > 0);
        }
      } catch (_err) {
        // malformed keywords blob — leave tagsHint undefined, not fatal.
      }
    }

    items.push({
      rawUrl: loc,
      listingTitle: $url.find('news\\:title').first().text().trim() || undefined,
      publishedHint,
      externalId: extractExternalId(loc),
      tagsHint,
    });
  });

  return items.slice(0, limit);
}

/**
 * Merges hub-sourced and sitemap-sourced entries, de-duplicating by normalized (query-string-
 * stripped) URL. Hub entries are listed first (freshest/most-relevant ordering, per task
 * brief "category hubs" as the primary channel); sitemap entries not already seen are appended
 * up to `limit`, tagged with their own `discoveryChannel` so callers can tell which channel
 * actually surfaced a given item (see module header "Sitemap secondary channel" note).
 * @param {Array} hubEntries
 * @param {Array} sitemapEntries
 * @param {number} limit
 * @param {string} section
 * @returns {Array<Object>} raw `DiscoveredItem`-shaped (camelCase) entries.
 */
function mergeDiscoveryEntries(hubEntries, sitemapEntries, limit, section) {
  const items = [];
  const seenNormalized = new Set();

  for (const entry of hubEntries) {
    if (items.length >= limit) break;
    const normalizedUrl = stripQueryString(entry.rawUrl);
    if (seenNormalized.has(normalizedUrl)) continue;
    seenNormalized.add(normalizedUrl);
    items.push({
      rawUrl: entry.rawUrl,
      normalizedUrl,
      discoveryChannel: `category_hub:${section}`,
      listingTitle: entry.listingTitle,
      externalId: entry.externalId,
      categoryHint: entry.categoryHint,
    });
  }

  for (const entry of sitemapEntries) {
    if (items.length >= limit) break;
    const normalizedUrl = stripQueryString(entry.rawUrl);
    if (seenNormalized.has(normalizedUrl)) continue;
    seenNormalized.add(normalizedUrl);
    items.push({
      rawUrl: entry.rawUrl,
      normalizedUrl,
      discoveryChannel: `sitemap:${section}`,
      listingTitle: entry.listingTitle,
      publishedHint: entry.publishedHint,
      externalId: entry.externalId,
      tagsHint: entry.tagsHint,
    });
  }

  return items;
}

/**
 * @param {{limit?: number, discoverLimit?: number, category?: string, section?: string, channelUrl?: string, useSitemap?: boolean, logger?: Object}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const section = (ctx && (ctx.category || ctx.section)) || DEFAULT_SECTION;
  const hubUrl = (ctx && ctx.channelUrl) || buildCategoryUrl({ section });
  const useSitemap = !ctx || ctx.useSitemap !== false;

  let hubEntries = [];
  try {
    const response = await axios.get(hubUrl, {
      headers: { 'User-Agent': CRAWLER_UA },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
      responseType: 'text',
    });
    if (response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
      hubEntries = extractHubItems(response.data, limit);
    }
  } catch (err) {
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(`merdeka discoverLive: hub fetch failed for section "${section}": ${err.message}`);
    }
  }

  let sitemapEntries = [];
  if (useSitemap) {
    try {
      const sitemapUrl = buildSitemapUrl({ section });
      const response = await axios.get(sitemapUrl, {
        headers: { 'User-Agent': CRAWLER_UA },
        timeout: HTTP_TIMEOUT_MS,
        validateStatus: () => true,
        responseType: 'text',
      });
      if (response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
        sitemapEntries = extractSitemapItems(response.data, limit);
      }
    } catch (err) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`merdeka discoverLive: sitemap fetch failed for section "${section}": ${err.message}`);
      }
    }
  }

  return { items: mergeDiscoveryEntries(hubEntries, sitemapEntries, limit, section) };
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
        ctx.logger.warn(`merdeka discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const section = (ctx && (ctx.category || ctx.section)) || DEFAULT_SECTION;
  const hubEntries = extractHubItems(readFixture(FIXTURE_LISTING_PATH), limit);
  const sitemapEntries = extractSitemapItems(readFixture(FIXTURE_SITEMAP_PATH), limit);

  return { items: mergeDiscoveryEntries(hubEntries, sitemapEntries, limit, section) };
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
 * Extracts the inline `window.kly = {...};` state object (verified live to be a well-formed
 * JSON object literal assigned to a global — see module header "hybrid JSON-LD/meta + body
 * DOM" note). Used only as a last-resort fallback for `category`/`author_name` when the
 * breadcrumb/byline DOM is ever absent. Non-greedy up to the first `});`-less `};` is safe
 * here because every nested sub-object in this state shape closes with `},"` (a comma
 * continuing the outer object), never a bare `};` — only the true top-level close does.
 * @param {string} rawHtml
 * @returns {Object|undefined}
 */
function extractKlyState(rawHtml) {
  if (typeof rawHtml !== 'string') return undefined;
  const match = /window\.kly\s*=\s*(\{[\s\S]*?\});/.exec(rawHtml);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {string|undefined} value - already-tz'd ISO-ish string (verified live `article:
 *   published_time`/`article:modified_time` meta AND JSON-LD `datePublished`/`dateModified`
 *   always carry an explicit `+07:00` offset — no "assume WIB" fallback needed here).
 * @returns {string|undefined}
 */
function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * DOM source for `category`: the LAST breadcrumb `<li>` under `nav.breadcrumb-navigation`
 * (verified live — for the current page this is a plain `<span>`, not a link; see module
 * header "The BreadcrumbList JSON-LD is USELESS for category" note on why the JSON-LD
 * breadcrumb can't be used instead).
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined}
 */
function extractCategoryFromDom($) {
  const text = $('nav.breadcrumb-navigation li').last().text().trim();
  return text.length > 0 ? text : undefined;
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]} tags from `.tags-articles__list a` (verified live — see module header
 *   "Tags" note).
 */
function extractTagsFromDom($) {
  return $('.tags-articles__list a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]} tags from `meta[name="keywords"]`'s comma-separated list (fallback).
 */
function extractTagsFromMeta($) {
  const raw = $('meta[name="keywords"]').attr('content');
  if (!raw) return [];
  return raw
    .split(',')
    .map((kw) => kw.trim())
    .filter((kw) => kw.length > 0);
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]} paragraphs from DOM `.articles-content__body > p` (DIRECT children only
 *   — verified live, see module header "Body paragraphs" note on why this excludes ad-slot and
 *   "Baca Juga" noise for free, and "Multipage articles" note on why every inlined page's
 *   paragraphs are already present in one fetch).
 */
function extractParagraphs($) {
  return $('.articles-content__body > p')
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
  const kly = extractKlyState(rawHtml);

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    articleLd.url ||
    undefined;

  const title =
    articleLd.headline ||
    $('h1.articles-content__title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const summary =
    $('meta[name="description"]').attr('content') ||
    (typeof articleLd.description === 'string' ? articleLd.description.trim() : '') ||
    $('.articles-content__sinopsis').first().text().trim() ||
    undefined;

  // JSON-LD author[0].name is verified live to be `null` — never usable (see module header).
  const author =
    $('meta[name="author"]').attr('content') ||
    $('[data-tracking="author_name"]').first().text().trim() ||
    (kly && kly.article && kly.article.reporters) ||
    undefined;

  const publishedAt =
    toIsoOrUndefined($('meta[property="article:published_time"]').attr('content')) ||
    toIsoOrUndefined(articleLd.datePublished);
  const updatedAt =
    toIsoOrUndefined($('meta[property="article:modified_time"]').attr('content')) ||
    toIsoOrUndefined(articleLd.dateModified);

  const ldImage = articleLd.image;
  const thumbnailUrl =
    (Array.isArray(ldImage) ? ldImage[0] : ldImage) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const category = extractCategoryFromDom($) || (kly && kly.category && kly.category.name) || undefined;

  const domTags = extractTagsFromDom($);
  let tags = domTags.length > 0 ? domTags : extractTagsFromMeta($);
  if (tags.length === 0 && typeof articleLd.keywords === 'string' && articleLd.keywords.trim()) {
    tags = articleLd.keywords
      .split(',')
      .map((kw) => kw.trim())
      .filter((kw) => kw.length > 0);
  }

  const externalArticleId = extractExternalId(url || '');
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
  // exported for unit tests / offline smoke script (fixtures/merdeka/smoke-test.js) and for
  // debugging extraction logic in isolation.
  isInScope,
  extractExternalId,
  stripQueryString,
  buildCategoryUrl,
  buildSitemapUrl,
  extractHubItems,
  extractSitemapItems,
  mergeDiscoveryEntries,
  extractJsonLdBlocks,
  findByType,
  extractKlyState,
  extractCategoryFromDom,
  extractTagsFromDom,
  extractTagsFromMeta,
  extractParagraphs,
  discoverLive,
  isLiveDiscoverEnabled,
  ALLOWED_HOST,
  FIXTURE_LISTING_PATH,
  FIXTURE_SITEMAP_PATH,
  FIXTURE_ARTICLE_PATH,
};
