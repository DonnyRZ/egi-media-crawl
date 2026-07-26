'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * VIVA (viva.co.id) adapter — Pilot P3.
 *
 * Implements the `src/adapters/_template` contract (camelCase field names). See
 * `./coreAdapter.js` for the bridge to the snake_case shape `src/core` (F3) expects,
 * and that file's header + field-matrix comment for how each ParsedArticle field is
 * sourced (JSON-LD vs DOM) and how confident we are in it.
 *
 * Assessment notes this adapter encodes (playbook-style, source: pilot brief):
 *  - crawlable / go-with-limits. Scope: www.viva.co.id ONLY (no subdomains).
 *  - Discovery: SSR HTML of https://www.viva.co.id/indeks is enough for a first batch
 *    (~34 links as of 2026-07-24, in `.article-list-row` items); depth beyond that was
 *    historically a POST to `/request/load-more-indeks` with a `last_publish_date` +
 *    CSRF token, but the live page no longer exposes that cursor (no csrf meta tag,
 *    `#load-more-btn` carries no data attributes) — `extractLoadMoreCursor` now simply
 *    returns `null` and load-more is skipped; the first-batch SSR HTML is relied on
 *    alone. Still NOT `?page=` on /indeks itself.
 *  - Article URL shape: `/{kanal}/[sub/]{id}-{slug}` e.g.
 *      https://www.viva.co.id/berita/1234561-judul-artikel-slug
 *      https://www.viva.co.id/otomotif/mobil/1234562-judul-artikel-slug
 *  - Article page is hybrid: JSON-LD `NewsArticle` (headline/dates/author/image/
 *    description, but NO `articleBody`) + DOM `.main-content-detail` for the body.
 *  - `summary` <- JSON-LD `description` > `og:description` > `meta[name=description]`.
 *  - `thumbnailUrl` <- JSON-LD `image` > `og:image` > DOM hero img (best-effort).
 *  - Multipage articles use `?page=N`; those pages must be fetched + merged, and the
 *    canonical URL we record must NOT carry the `page` param.
 *  - Cleanup before extracting body paragraphs: `.recommended-article` ("Baca Juga")
 *    blocks and ad slots (`.ads`, `.adsbygoogle`, etc.) must be stripped.
 *  - `dateModified` is often unreliable on this source; `datePublished` is preferred
 *    and `updated_at_source` is only carried through as a low-confidence value.
 *
 * SAFETY: both `discover()` and the extra-page fetches inside `parse()` default to
 * fixture/offline mode. They only perform live HTTP when `process.env.CRAWL_LIVE ===
 * 'true'` (same convention as `src/workers/lib/fetchHtml.js`), so simply registering
 * this adapter never causes surprise network traffic during discovery or multipage
 * merge. (The single "page 1" fetch for `parse(html, ctx)` itself is performed by
 * whatever `fetchFn` the caller injects into `runPipeline` — that is outside this
 * adapter's control, same as every other adapter.)
 */

const SOURCE_ID = 'viva';
const BASE_URL = 'https://www.viva.co.id/';
const INDEKS_URL = 'https://www.viva.co.id/indeks';
const LOAD_MORE_PATH = '/request/load-more-indeks';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'viva');
const FIXTURE_INDEKS_PATH = path.join(FIXTURES_DIR, 'indeks.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');
const FIXTURE_ARTICLE_PAGE2_PATH = path.join(FIXTURES_DIR, 'sample-article-page2.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const DEFAULT_DISCOVERY_LIMIT = 8;
const MAX_MERGED_PAGES = 20; // safety cap so a malformed pagination count can't loop forever

// Article URLs: https://www.viva.co.id/{kanal}[/{sub}]/{numericId}-{slug}[?query]
// Scope is deliberately restricted to the bare `www.viva.co.id` host (no other
// subdomains) per the assessment notes.
const ARTICLE_URL_PATTERN =
  /^https?:\/\/www\.viva\.co\.id\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\/(\d+)-[a-z0-9-]+\/?(?:\?.*)?$/i;

// Listing/tag/search/media pages that structurally match ARTICLE_URL_PATTERN's shape
// closely enough that we still want an explicit exclusion list.
const NON_ARTICLE_PATH_PATTERN = /\/(indeks|tag|search|foto|video|about|redaksi|pedoman-media-siber)(\/|$|\?)/i;

function isLiveCrawlEnabled() {
  return process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

/**
 * @param {string} url
 * @returns {string|undefined} numeric external id embedded in the last path segment.
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  const match = /\/(\d+)-[a-z0-9-]+\/?(?:\?.*)?$/i.exec(url);
  return match ? match[1] : undefined;
}

/**
 * @param {string} url
 * @returns {string|undefined} the `{kanal}` path segment, used as a discovery-time
 *   category hint (low confidence — the real category should come from the article
 *   page / JSON-LD `articleSection` once parsed).
 */
function extractChannelHint(url) {
  try {
    const { pathname } = new URL(url);
    const segment = pathname.split('/').filter(Boolean)[0];
    return segment || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strips the `page` query param so multipage article URLs collapse to one canonical
 * identity (per assessment notes: "canonical without page; multipage merge").
 * @param {string} url
 * @returns {string}
 */
function stripPageParam(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('page');
    return parsed.toString();
  } catch {
    return url;
  }
}

function buildPageUrl(canonicalUrl, pageNumber) {
  try {
    const parsed = new URL(canonicalUrl);
    parsed.searchParams.set('page', String(pageNumber));
    return parsed.toString();
  } catch {
    return `${canonicalUrl}${canonicalUrl.includes('?') ? '&' : '?'}page=${pageNumber}`;
  }
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'VIVA.co.id',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 20,
    overlapHours: 3,
    enabled: true,
  };
}

function isArticleUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  if (NON_ARTICLE_PATH_PATTERN.test(url)) {
    return false;
  }
  return ARTICLE_URL_PATTERN.test(url);
}

/**
 * Parses an /indeks (or load-more) HTML fragment into discovery entries. Shared by both
 * the fixture and live paths so the extraction logic is identical either way.
 * @param {string} html
 * @returns {Array<{rawUrl: string, listingTitle: string, publishedHint: string, externalId: string, categoryHint: string}>}
 */
function extractIndeksItems(html) {
  const $ = cheerio.load(html);

  // Current markup (verified live 2026-07-24): each listing entry is a
  // `.article-list-row` inside `.article-list-container`, with the article link +
  // headline in `a.article-list-title` (an `<h2>` inside), and a human-readable
  // (non-ISO) publish string in `.article-list-date span`. The old `.articles--item`
  // / `.articles--item-title` / `time.articles--item-date[datetime]` selectors no
  // longer exist on the page (markup drift) — this replaces them.
  return $('.article-list-row')
    .map((_, el) => {
      const $el = $(el);
      const $titleLink = $el.find('a.article-list-title').first();
      const href = $titleLink.attr('href') || $el.find('a').first().attr('href');
      if (!href || !isArticleUrl(href)) return null;

      const listingTitle =
        $titleLink.find('h2').first().text().trim() || $titleLink.text().trim() || undefined;
      // No `datetime` attribute is exposed anymore; this is a best-effort, low-
      // confidence Indonesian date string (see coreAdapter.js `tryParseHint`, same
      // graceful-degrade pattern already used for detik/suara).
      const publishedHint = $el.find('.article-list-date span').first().text().trim() || undefined;

      return {
        rawUrl: href,
        listingTitle,
        publishedHint,
        externalId: extractExternalId(href),
        categoryHint: extractChannelHint(href),
      };
    })
    .get()
    .filter(Boolean);
}

/**
 * Best-effort extraction of the CSRF token + last-seen publish-date cursor needed to
 * call the load-more endpoint, straight from the SSR HTML (no JS execution). Returns
 * `null` if either piece is missing — callers must treat load-more as fully optional.
 * @param {string} html
 * @returns {{csrfToken: string, lastPublishDate: string}|null}
 */
function extractLoadMoreCursor(html) {
  const $ = cheerio.load(html);
  const csrfToken =
    $('meta[name="csrf-token"]').attr('content') || $('#load-more-indeks').attr('data-csrf-token');
  const lastPublishDate = $('#load-more-indeks').attr('data-last-publish-date');

  if (!csrfToken || !lastPublishDate) return null;
  return { csrfToken, lastPublishDate };
}

/**
 * One best-effort POST to `/request/load-more-indeks` (live mode only) to extend the
 * first-batch discovery a little past the initial SSR HTML. Non-fatal: any failure
 * (network error, unexpected response shape, endpoint contract mismatch) just means we
 * ship the SSR batch alone, since this is optional depth per the assessment notes.
 * @param {{csrfToken: string, lastPublishDate: string}} cursor
 * @returns {Promise<ReturnType<typeof extractIndeksItems>>}
 */
async function fetchLoadMoreBatch(cursor) {
  try {
    const response = await axios.post(
      new URL(LOAD_MORE_PATH, BASE_URL).toString(),
      new URLSearchParams({ last_publish_date: cursor.lastPublishDate }).toString(),
      {
        headers: {
          'User-Agent': CRAWLER_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-TOKEN': cursor.csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    );

    if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
      return [];
    }
    return extractIndeksItems(response.data);
  } catch {
    return [];
  }
}

/**
 * @param {import('../_template').AdapterContext & {limit?: number, discoveryLimit?: number}} [ctx]
 *   `limit` (the `ctx.limit` convention shared with detik/suara, see coreAdapter.js/
 *   scripts/crawl-once.js) takes priority; `discoveryLimit` is kept as a back-compat alias.
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx) {
  const limit = (ctx && (ctx.limit || ctx.discoveryLimit)) || DEFAULT_DISCOVERY_LIMIT;
  const live = isLiveCrawlEnabled();

  let indeksHtml;
  let discoveryChannel = 'fixture';

  if (live) {
    const response = await axios.get(INDEKS_URL, {
      headers: { 'User-Agent': CRAWLER_UA },
      timeout: 15000,
      validateStatus: () => true,
      responseType: 'text',
    });
    if (response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
      indeksHtml = response.data;
      discoveryChannel = 'indeks_ssr';
    }
  }

  if (!indeksHtml) {
    indeksHtml = readFixture(FIXTURE_INDEKS_PATH);
  }

  let entries = extractIndeksItems(indeksHtml);

  // Optional one-shot depth via load-more — only attempted live, only when the SSR HTML
  // actually exposed a usable CSRF token + cursor, and only if we still need more items.
  if (live && entries.length < limit) {
    const cursor = extractLoadMoreCursor(indeksHtml);
    if (cursor) {
      const loadMoreEntries = await fetchLoadMoreBatch(cursor);
      entries = entries.concat(
        loadMoreEntries.map((entry) => ({ ...entry, discoveryChannel: 'indeks_load_more' }))
      );
    }
  }

  const items = entries.slice(0, limit).map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: stripPageParam(entry.rawUrl),
    discoveryChannel: entry.discoveryChannel || discoveryChannel,
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    externalId: entry.externalId,
    categoryHint: entry.categoryHint,
  }));

  return { items };
}

/**
 * Extracts the first `NewsArticle` JSON-LD block, if present. VIVA's JSON-LD does not
 * carry `articleBody` (per assessment notes) — this is only used for headline/dates/
 * author/image metadata; body text always comes from the DOM.
 * @param {cheerio.CheerioAPI} $
 * @returns {Object|undefined}
 */
function extractNewsArticleJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    const raw = $(script).contents().text();
    if (!raw || !raw.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    const newsArticle = candidates.find((entry) => {
      const type = entry && entry['@type'];
      return type === 'NewsArticle' || (Array.isArray(type) && type.includes('NewsArticle'));
    });
    if (newsArticle) return newsArticle;
  }
  return undefined;
}

/**
 * Extracts body paragraphs from `.main-content-detail`, after stripping "Baca Juga"
 * recommendation blocks and ad slots (per assessment notes' cleanup requirement).
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractBodyParagraphs($) {
  const $content = $('.main-content-detail').first().clone();
  $content.find('.recommended-article, .ads, .adsbygoogle, .ad-slot, script, style').remove();

  return $content
    .find('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

/**
 * Reads the pagination widget to determine how many pages this article spans, plus an
 * explicit href-per-page map (preferred over blindly assuming `?page=N` works the same
 * way the canonical URL does).
 * @param {cheerio.CheerioAPI} $
 * @returns {{totalPages: number, pageUrls: Map<number, string>}}
 */
function detectPagination($) {
  const $pagination = $('.pagination-detail').first();
  const totalPagesAttr = parseInt($pagination.attr('data-total-pages'), 10);
  const totalPages = Number.isFinite(totalPagesAttr) && totalPagesAttr > 0 ? totalPagesAttr : 1;

  const pageUrls = new Map();
  $pagination.find('a[data-page]').each((_, el) => {
    const pageNumber = parseInt($(el).attr('data-page'), 10);
    const href = $(el).attr('href');
    if (Number.isFinite(pageNumber) && href) {
      pageUrls.set(pageNumber, href);
    }
  });

  return { totalPages: Math.min(totalPages, MAX_MERGED_PAGES), pageUrls };
}

/**
 * Live-mode helper: fetches one additional article page over HTTP. Only ever called
 * when `process.env.CRAWL_LIVE === 'true'` (see `collectPageHtmls`), so registering/
 * testing this adapter offline never triggers it.
 * @param {string} pageUrl
 * @returns {Promise<string|undefined>}
 */
async function fetchLivePage(pageUrl) {
  const response = await axios.get(pageUrl, {
    headers: { 'User-Agent': CRAWLER_UA },
    timeout: 15000,
    validateStatus: () => true,
    responseType: 'text',
  });
  if (response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
    return response.data;
  }
  return undefined;
}

/**
 * Collects the HTML for every page of a (possibly multipage) article, merging page 1
 * (already-fetched `firstPageHtml`) with pages 2..N.
 *
 * Resolution order for how to fetch pages 2..N:
 *   1. `ctx.fetchPage(pageUrl, pageNumber)` — injected by tests/callers (offline-safe).
 *   2. Bundled fixture page files, IF the first page itself came from the bundled
 *      fixture (keeps `npm`-free offline smoke testing working out of the box for the
 *      canned sample article).
 *   3. Live HTTP via axios, IF `CRAWL_LIVE=true`.
 *   4. Otherwise: give up gracefully and merge only page 1 (best-effort, matches how
 *      `parse()` already degrades gracefully elsewhere in this codebase).
 *
 * @param {string} firstPageHtml
 * @param {string} canonicalUrl
 * @param {import('../_template').AdapterContext} [ctx]
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
        pageHtml = await fetchLivePage(pageUrl);
      }
    } catch {
      pageHtml = undefined;
    }

    if (!pageHtml) break; // non-fatal: ship whatever pages we already merged
    pages.push(pageHtml);
  }

  return pages;
}

function readFixtureSafe(fixturePath) {
  try {
    return readFixture(fixturePath);
  } catch {
    return undefined;
  }
}

/**
 * @param {import('../_template').AdapterContext} [ctx]
 * @returns {string}
 */
function resolveFirstPageHtml(html) {
  return typeof html === 'string' && html.length > 0 ? html : readFixture(FIXTURE_ARTICLE_PATH);
}

/**
 * @param {string} html - page-1 HTML (fetched or fixture).
 * @param {import('../_template').AdapterContext} [ctx]
 * @returns {Promise<Object>} raw ParsedArticle-like draft (camelCase), see coreAdapter.js
 *   for the mapping to the core snake_case shape + the field-provenance matrix.
 */
async function parse(html, ctx) {
  const firstPageHtml = resolveFirstPageHtml(html);
  const $ = cheerio.load(firstPageHtml);

  const jsonLd = extractNewsArticleJsonLd($);

  const canonicalUrlRaw =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (jsonLd && jsonLd.mainEntityOfPage) ||
    (ctx && ctx.url);
  const canonicalUrl = canonicalUrlRaw ? stripPageParam(canonicalUrlRaw) : undefined;

  const url = (ctx && ctx.url) || canonicalUrl;

  const title =
    (jsonLd && jsonLd.headline) ||
    $('.main-title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const authorFromJsonLd = jsonLd && jsonLd.author && (jsonLd.author.name || jsonLd.author);
  const author =
    (typeof authorFromJsonLd === 'string' && authorFromJsonLd) ||
    $('.date-time .author').first().text().trim() ||
    undefined;

  // datePublished is preferred over dateModified, which the assessment notes flag as
  // unreliable on this source (see coreAdapter.js field-provenance matrix).
  const publishedAtRaw = (jsonLd && jsonLd.datePublished) || $('.date-time time.date').attr('datetime');
  const publishedAt = publishedAtRaw ? new Date(publishedAtRaw).toISOString() : undefined;

  const updatedAtRaw = jsonLd && jsonLd.dateModified;
  const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).toISOString() : undefined;

  const jsonLdImage =
    jsonLd && jsonLd.image && (typeof jsonLd.image === 'string' ? jsonLd.image : jsonLd.image.url);
  const thumbnailUrl =
    jsonLdImage ||
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('.main-content-image img, .article-image img, figure img').first().attr('src') ||
    undefined;

  const summary =
    (jsonLd && jsonLd.description) ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const category = jsonLd && jsonLd.articleSection;

  const pageHtmls = canonicalUrl ? await collectPageHtmls(firstPageHtml, canonicalUrl, ctx) : [firstPageHtml];

  const paragraphs = pageHtmls.flatMap((pageHtml, index) => {
    const $page = index === 0 ? $ : cheerio.load(pageHtml);
    return extractBodyParagraphs($page);
  });

  return {
    sourceId: SOURCE_ID,
    url,
    canonicalUrl,
    externalId: extractExternalId(url || ''),
    title,
    summary,
    author,
    category,
    thumbnailUrl,
    publishedAt,
    updatedAt,
    paragraphs,
    pagesMerged: pageHtmls.length,
    rawHtml: firstPageHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/viva/smoke-test.js) and
  // for debugging extraction logic in isolation.
  extractExternalId,
  extractIndeksItems,
  extractLoadMoreCursor,
  extractNewsArticleJsonLd,
  extractBodyParagraphs,
  detectPagination,
  stripPageParam,
  isLiveCrawlEnabled,
};
