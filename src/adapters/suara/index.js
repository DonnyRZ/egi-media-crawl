'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const { isOlderThanCutoff, takeUntilOverlapCutoff } = require('../../core/overlap');

/**
 * Suara (suara.com) adapter — camelCase raw stub, following the same
 * fixture-first pattern as `src/adapters/detik/index.js`. `src/adapters/suara/coreAdapter.js`
 * bridges this to the snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment summary (see task brief):
 *  - crawlable / go-with-limits. Scope restricted to the `www.suara.com` host only
 *    (other (sub)domains like `yoursay.suara.com` are out of scope for this adapter).
 *  - Discovery: `https://www.suara.com/indeks` (+ `?page=N`), ~20 items/page, stop when a
 *    page yields zero article links. `discover()` defaults to a small offline fixture
 *    listing (network-free, mirrors the Detik pilot); pass `ctx.liveDiscover = true` (or set
 *    `CRAWL_LIVE=true`) to opt into a light live fetch capped at `DEFAULT_DISCOVER_LIMIT`
 *    URLs across at most `DEFAULT_DISCOVER_MAX_PAGES` pages.
 *  - URL pattern: `/{kanal}/{YYYY}/{MM}/{DD}/{HHMMSS}/{slug}`, e.g.
 *    `https://www.suara.com/news/2026/07/24/070859/contoh-judul-berita`.
 *  - Article pages are "hybrid": JSON-LD `NewsArticle` (metadata only, no `articleBody`) +
 *    a `dataLayer` GTM push (carries `articleContentId`/external id + `articleTotalPages`)
 *    + the actual paragraph text lives only in DOM `.article-content`.
 *  - Multipage: long articles split body text across `?page=2`, `?page=3`, ... of the same
 *    canonical URL (`.pagination-custom` / `dataLayer.articleTotalPages`). `parse()` detects
 *    this and, if the caller supplies `ctx.fetchPage(pageUrl, pageNumber)`, fetches + merges
 *    the remaining pages' `.article-content` paragraphs in canonical-URL order. See
 *    `mergeAdditionalPages()` below. Without `ctx.fetchPage`, `parse()` still returns a valid
 *    (page-1-only) article plus a `multipage` note so callers can see merge was skipped.
 *  - Cleanup: ad slots (`[id*="div-ad"]`, `.placeholder_belt`, `.placeholder_read_body`),
 *    `.ten-second` ("baca 10 detik" boxes, which also recur on every subsequent page),
 *    `.article-read` ("Baca Juga" inline recirculation), `#next-article` overlay,
 *    `.wrap-pagination` / `.article-tags` (parsed separately, not part of body text).
 *  - robots.txt: `Disallow: /loadmoredetail?` — never construct/follow that endpoint;
 *    `isArticleUrl()` rejects it defensively even though it wouldn't match the article
 *    pattern anyway.
 *
 * Field matrix (source -> ParsedArticle field, see coreAdapter.js for the snake_case names):
 *   title          <- JSON-LD `headline` > DOM `.article-image h1` > og:title > <title>
 *   author         <- JSON-LD `author[].name` (joined) > DOM `.author-trigger a` (joined)
 *   publishedAt    <- JSON-LD `datePublished` (has tz offset) > dataLayer `articleDate`
 *                     (naive, assumed Asia/Jakarta +07:00)
 *   updatedAt      <- JSON-LD `dateModified`
 *   summary        <- JSON-LD `description` > dataLayer `articleSummary`
 *   category       <- dataLayer `articleSubcategory` > `articleCategory`
 *   tags           <- DOM `.article-tags a` text (leading "#" stripped)
 *   thumbnailUrl   <- JSON-LD `image.url` > og:image
 *   externalId     <- dataLayer `articleContentId`
 *   paragraphs     <- DOM `.article-content p` (after stripping ads/boilerplate), merged
 *                     across pages when multipage + `ctx.fetchPage` is available
 *   url (canonical)<- ctx.url > <link rel="canonical"> > og:url > JSON-LD `mainEntityOfPage.@id`
 */

const SOURCE_ID = 'suara';
const BASE_URL = 'https://www.suara.com/';
const ALLOWED_HOST = 'www.suara.com';
const INDEKS_URL = 'https://www.suara.com/indeks';

const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'fixtures', 'suara', 'sample-article.html');
const FIXTURE_PATH_PAGE2 = path.join(__dirname, '..', '..', '..', 'fixtures', 'suara', 'sample-article-page2.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';

const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range
const DEFAULT_DISCOVER_MAX_PAGES = 3;

// Suara article URLs: https://www.suara.com/{kanal}/{YYYY}/{MM}/{DD}/{HHMMSS}/{slug}
// Host is pinned to www.suara.com on purpose — other (sub)domains surfaced from /indeks
// (e.g. yoursay.suara.com) are out of scope for this adapter.
const ARTICLE_URL_PATTERN = /^https?:\/\/www\.suara\.com\/[a-z0-9-]+\/\d{4}\/\d{2}\/\d{2}\/\d{6}\/[a-z0-9-]+\/?(?:\?.*)?$/i;

// /foto and /video are photo/video-gallery content types (not the text-body shape this
// adapter parses), same treatment as detik's stub. /author and /reporter are byline pages.
const NON_ARTICLE_PATH_PATTERN = /\/(tag|indeks|search|author|reporter|foto|video)(\/|$|\?)/i;

// robots.txt: `Disallow: /loadmoredetail?` — belt-and-suspenders check, see module header.
const DISALLOWED_PATH_PATTERN = /\/loadmoredetail\b/i;

// Elements to strip from `.article-content` before extracting paragraph text. Ad slots,
// "baca 10 detik" boxes, and "Baca Juga" recirculation blocks all recur on every page of a
// multipage article, so this list is applied per-page inside extractArticleParagraphs().
const STRIP_SELECTORS = [
  'script',
  'style',
  '.ten-second',
  '.article-read',
  '#next-article',
  '.next-article',
  '[id*="div-ad"]',
  '.placeholder_belt',
  '.placeholder_read_body',
  '.wrap-pagination',
  '.article-tags',
  '.google-pref',
];

// Fixture "listing" used by discover() when live discovery isn't requested. Mirrors what a
// real `/indeks` crawl would surface; parse() reads the bundled fixture file for the first
// entry regardless of the URL passed in (network-free default, same as the Detik pilot).
const FIXTURE_LISTING = [
  {
    rawUrl: 'https://www.suara.com/news/2026/07/24/070859/contoh-judul-berita-suara-multipage',
    listingTitle: 'Contoh Judul Berita Suara Multipage',
    publishedHint: "Jum'at, 24 Juli 2026 | 07:08 WIB",
  },
  {
    rawUrl: 'https://www.suara.com/bisnis/2026/07/24/060000/contoh-judul-berita-suara-kedua',
    listingTitle: 'Contoh Judul Berita Suara Kedua',
    publishedHint: "Jum'at, 24 Juli 2026 | 06:00 WIB",
  },
];

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Suara.com',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 15,
    overlapHours: 2,
    enabled: true,
  };
}

function isArticleUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  if (DISALLOWED_PATH_PATTERN.test(url)) {
    return false;
  }
  if (NON_ARTICLE_PATH_PATTERN.test(url)) {
    return false;
  }
  return ARTICLE_URL_PATTERN.test(url);
}

function isInScope(absoluteUrl) {
  try {
    return new URL(absoluteUrl).hostname.toLowerCase() === ALLOWED_HOST;
  } catch (err) {
    return false;
  }
}

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

/**
 * Live "light" discovery: fetches `/indeks` (+ `?page=N`) with the shared CRAWLER_UA,
 * capped at `limit` URLs / `maxPages` pages, stopping as soon as a page yields no new
 * in-scope article links (per assessment notes: "~20/page; stop when empty").
 *
 * Overlap-window stop condition (Sprint 8, S8-B; Sprint 13 Indonesian hint parse via
 * `src/core/parseListingDate.js` in `isOlderThanCutoff`): when `ctx.overlapCutoffAt` is
 * given, pagination also stops as soon as an item's `publishedHint` (scraped from
 * `.article-kanal-info h4 span`) both parses AND is older than the cutoff -- listing pages
 * here are newest-first, so everything after that point is outside the overlap window.
 *
 * RESIDUAL (S13-D): live indeks often shows a time-only fragment for "today" items
 * (e.g. `"07:08"`) with no absolute day — those remain unparseable by design, so overlap
 * cannot confidently stop on those rows and still relies on `limit`/`maxPages`. Full
 * Indonesian date strings (fixture / older live rows) do parse and can stop mid-list.
 *
 * @param {{limit?: number, discoverLimit?: number, discoverMaxPages?: number,
 *   overlapCutoffAt?: string, logger?: Object}} [ctx]
 *   `limit` (the `ctx.limit` convention shared with detik/viva, see coreAdapter.js/
 *   scripts/crawl-once.js) takes priority; `discoverLimit` is kept as a back-compat alias.
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  // Required lazily so environments that never opt into live discovery don't pay for it.
  const axios = require('axios');

  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const maxPages = (ctx && ctx.discoverMaxPages) || DEFAULT_DISCOVER_MAX_PAGES;
  const logger = ctx && ctx.logger;
  const cutoffAtRaw = ctx && ctx.overlapCutoffAt ? new Date(ctx.overlapCutoffAt) : undefined;
  const cutoffAt = cutoffAtRaw && !Number.isNaN(cutoffAtRaw.getTime()) ? cutoffAtRaw : undefined;

  const items = [];
  const seen = new Set();

  pageLoop: for (let page = 1; page <= maxPages && items.length < limit; page += 1) {
    const pageUrl = page === 1 ? INDEKS_URL : `${INDEKS_URL}?page=${page}`;

    let html;
    try {
      const response = await axios.get(pageUrl, {
        headers: { 'User-Agent': CRAWLER_UA },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300) {
        break;
      }
      html = response.data;
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`suara discoverLive: failed to fetch ${pageUrl}: ${err.message}`);
      }
      break;
    }

    const $ = cheerio.load(typeof html === 'string' ? html : String(html));
    const anchors = $('.article-kanal-list .article-kanal-item h3 a').toArray();
    if (anchors.length === 0) {
      break; // "stop when empty"
    }

    let addedThisPage = 0;
    for (const el of anchors) {
      if (items.length >= limit) break;
      const $a = $(el);
      const href = $a.attr('href');
      if (!href) continue;

      let absoluteUrl;
      try {
        absoluteUrl = new URL(href, BASE_URL).toString();
      } catch (err) {
        continue;
      }

      if (!isInScope(absoluteUrl) || !isArticleUrl(absoluteUrl) || seen.has(absoluteUrl)) {
        continue;
      }
      seen.add(absoluteUrl);
      addedThisPage += 1;

      const publishedHint = $a
        .closest('.article-kanal-info')
        .find('h4 span')
        .first()
        .text()
        .trim();

      // Overlap-window stop condition (see module doc above): listings are newest-first, so
      // once one item is confidently older than the cutoff, every subsequent item (this page
      // and any further page) is too -- stop discovering entirely rather than just this page.
      if (cutoffAt && isOlderThanCutoff(publishedHint, cutoffAt)) {
        break pageLoop;
      }

      items.push({
        rawUrl: absoluteUrl,
        normalizedUrl: absoluteUrl,
        discoveryChannel: page === 1 ? 'indeks' : 'indeks_page',
        listingTitle: $a.attr('title') || $a.text().trim(),
        publishedHint: publishedHint || undefined,
      });
    }

    if (addedThisPage === 0) {
      break; // whole page was out-of-scope/duplicate -> treat as empty
    }
  }

  return { items };
}

/**
 * @param {{overlapCutoffAt?: string}} [ctx]
 * @param {number} [limit]
 * @returns {Array<Object>}
 */
function fixtureListingWithOverlapStop(ctx, limit) {
  const items = FIXTURE_LISTING.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: entry.rawUrl,
    discoveryChannel: 'fixture',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
  }));

  const cutoffAt = ctx && ctx.overlapCutoffAt ? new Date(ctx.overlapCutoffAt) : undefined;
  if (!cutoffAt || Number.isNaN(cutoffAt.getTime())) {
    return typeof limit === 'number' && limit > 0 ? items.slice(0, limit) : items;
  }
  return takeUntilOverlapCutoff(items, { cutoffAt, limit, getPublishedHint: (item) => item.publishedHint });
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
        ctx.logger.warn(`suara discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  return { items: fixtureListingWithOverlapStop(ctx, ctx && (ctx.limit || ctx.discoverLimit)) };
}

/**
 * @param {string} value - date-ish string (JSON-LD has a tz offset; dataLayer's articleDate
 *   does not, e.g. "2026-07-24T07:08:59").
 * @param {boolean} [assumeJakartaIfNoTz] - append "+07:00" when `value` has no timezone.
 * @returns {string|undefined} ISO 8601 UTC string, or undefined if unparseable/absent.
 */
function tryParseDate(value, assumeJakartaIfNoTz) {
  if (!value || typeof value !== 'string') return undefined;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = !hasTz && assumeJakartaIfNoTz ? `${value}+07:00` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Extracts a single field pushed via the inline `dataLayer = [{ ... }]` GTM script. Uses a
 * targeted regex instead of evaluating the script (the object literal uses single-quoted
 * keys/strings, so it isn't valid JSON) — safe because we only ever read known field names.
 * @param {string} rawHtml
 * @param {string} fieldName
 * @returns {string|undefined}
 */
function extractDataLayerField(rawHtml, fieldName) {
  if (typeof rawHtml !== 'string') return undefined;
  const key = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const singleQuoted = rawHtml.match(new RegExp(`['"]${key}['"]\\s*:\\s*'([^']*)'`));
  if (singleQuoted) return singleQuoted[1];
  const doubleQuoted = rawHtml.match(new RegExp(`['"]${key}['"]\\s*:\\s*"([^"]*)"`));
  if (doubleQuoted) return doubleQuoted[1];
  const numeric = rawHtml.match(new RegExp(`['"]${key}['"]\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (numeric) return numeric[1];
  return undefined;
}

/**
 * Finds the JSON-LD `NewsArticle` node among all `<script type="application/ld+json">`
 * blocks on the page (Suara emits several: WebSite, NewsMediaOrganization, NewsArticle,
 * BreadcrumbList). Tolerates `@graph`-wrapped payloads defensively even though Suara
 * doesn't currently use that shape.
 * @param {cheerio.CheerioAPI} $
 * @returns {Object|undefined}
 */
function extractNewsArticleJsonLd($) {
  let result;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (result) return;
    let parsed;
    try {
      parsed = JSON.parse($(el).contents().text());
    } catch (err) {
      return;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (candidate && candidate['@type'] === 'NewsArticle') {
        result = candidate;
        return;
      }
      if (candidate && Array.isArray(candidate['@graph'])) {
        const fromGraph = candidate['@graph'].find((node) => node && node['@type'] === 'NewsArticle');
        if (fromGraph) {
          result = fromGraph;
          return;
        }
      }
    }
  });
  return result;
}

/**
 * Extracts cleaned body paragraphs from a single page's `.article-content` (ads/boilerplate
 * stripped per STRIP_SELECTORS). Called once per page — both for the initially-parsed HTML
 * and for every additional page fetched by mergeAdditionalPages().
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractArticleParagraphs($) {
  const $content = $('.article-content').first().clone();
  STRIP_SELECTORS.forEach((selector) => $content.find(selector).remove());
  return $content
    .find('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

/**
 * Determines how many pages the article is split across. Prefers `dataLayer.articleTotalPages`
 * (authoritative when present); falls back to the highest page number linked from
 * `.pagination-custom` (handles fixtures/pages that omit dataLayer).
 * @param {string} rawHtml
 * @param {cheerio.CheerioAPI} $
 * @returns {number} >= 1
 */
function parseTotalPages(rawHtml, $) {
  const fromDataLayer = extractDataLayerField(rawHtml, 'articleTotalPages');
  if (fromDataLayer) {
    const n = parseInt(fromDataLayer, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  let maxPage = 1;
  $('.pagination-custom a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const hrefMatch = href.match(/[?&]page=(\d+)/);
    if (hrefMatch) {
      maxPage = Math.max(maxPage, parseInt(hrefMatch[1], 10));
      return;
    }
    const text = $(el).text().trim();
    if (/^\d+$/.test(text)) {
      maxPage = Math.max(maxPage, parseInt(text, 10));
    }
  });
  return maxPage;
}

function normalizeForCompare(url) {
  try {
    const u = new URL(url);
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch (err) {
    return String(url || '').trim();
  }
}

function buildPageUrl(canonicalUrl, page) {
  const u = new URL(canonicalUrl);
  u.searchParams.set('page', String(page));
  return u.toString();
}

/**
 * Fetches and merges pages 2..totalPages of a multipage article, in order, stopping early
 * (without throwing) on any fetch failure or on a page whose own canonical/og:url doesn't
 * match — a defensive guard against merging in unrelated content.
 *
 * This is the "prefer merge in parse flow or helper" piece from the task brief: parse()
 * calls this directly rather than requiring a separate pipeline step. It relies entirely on
 * an injected `ctx.fetchPage(pageUrl, pageNumber)` (returning `Promise<string>` or
 * `Promise<{body: string}>`) so this module still performs no network I/O of its own when
 * used through the core pipeline (which supplies its own fetch fn) — the fixture-only smoke
 * test can supply a `ctx.fetchPage` that just reads a local file.
 *
 * @param {{canonicalUrl: string, totalPages: number, paragraphs: string[], ctx: Object}} params
 * @returns {Promise<{paragraphs: string[], pagesFetched: number}>}
 */
async function mergeAdditionalPages({ canonicalUrl, totalPages, paragraphs, ctx }) {
  const merged = paragraphs.slice();
  let pagesFetched = 1;

  for (let page = 2; page <= totalPages; page += 1) {
    const pageUrl = buildPageUrl(canonicalUrl, page);
    let pageHtml;
    try {
      const fetched = await ctx.fetchPage(pageUrl, page);
      pageHtml = typeof fetched === 'string' ? fetched : fetched && fetched.body;
    } catch (err) {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`suara mergeAdditionalPages: failed to fetch page ${page} for ${canonicalUrl}: ${err.message}`);
      }
      break;
    }
    if (!pageHtml) break;

    const $page = cheerio.load(pageHtml);
    const pageCanonical =
      $page('link[rel="canonical"]').attr('href') || $page('meta[property="og:url"]').attr('content');
    if (pageCanonical && normalizeForCompare(pageCanonical) !== normalizeForCompare(canonicalUrl)) {
      break; // page N doesn't claim to belong to this canonical URL -> don't merge it
    }

    merged.push(...extractArticleParagraphs($page));
    pagesFetched += 1;
  }

  return { paragraphs: merged, pagesFetched };
}

async function parse(html, ctx) {
  const rawHtml = typeof html === 'string' && html.length > 0 ? html : fs.readFileSync(FIXTURE_PATH, 'utf8');

  const $ = cheerio.load(rawHtml);
  const jsonLd = extractNewsArticleJsonLd($);

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (jsonLd && jsonLd.mainEntityOfPage && jsonLd.mainEntityOfPage['@id']) ||
    FIXTURE_LISTING[0].rawUrl;

  const title =
    (jsonLd && jsonLd.headline) ||
    $('.article-image h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const authorsFromJsonLd = Array.isArray(jsonLd && jsonLd.author)
    ? jsonLd.author.map((a) => a && a.name).filter(Boolean)
    : jsonLd && jsonLd.author && jsonLd.author.name
      ? [jsonLd.author.name]
      : [];
  const authorsFromDom = $('.author-trigger a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  const author = (authorsFromJsonLd.length > 0 ? authorsFromJsonLd : authorsFromDom).join(', ') || undefined;

  const publishedAt =
    tryParseDate(jsonLd && jsonLd.datePublished) || tryParseDate(extractDataLayerField(rawHtml, 'articleDate'), true);
  const updatedAt = tryParseDate(jsonLd && jsonLd.dateModified);

  const summary = (jsonLd && jsonLd.description) || extractDataLayerField(rawHtml, 'articleSummary') || undefined;

  const category =
    extractDataLayerField(rawHtml, 'articleSubcategory') || extractDataLayerField(rawHtml, 'articleCategory') || undefined;

  const tags = $('.article-tags a')
    .map((_, el) => $(el).text().replace(/^#\s*/, '').trim())
    .get()
    .filter(Boolean);

  const thumbnailUrl =
    (jsonLd && jsonLd.image && jsonLd.image.url) || $('meta[property="og:image"]').attr('content') || undefined;

  const externalId = extractDataLayerField(rawHtml, 'articleContentId') || undefined;

  const page1Paragraphs = extractArticleParagraphs($);
  const totalPages = parseTotalPages(rawHtml, $);

  let paragraphs = page1Paragraphs;
  let pagesFetched = 1;
  let multipageNote;

  if (totalPages > 1) {
    if (ctx && typeof ctx.fetchPage === 'function') {
      const merged = await mergeAdditionalPages({ canonicalUrl: url, totalPages, paragraphs: page1Paragraphs, ctx });
      paragraphs = merged.paragraphs;
      pagesFetched = merged.pagesFetched;
      if (pagesFetched < totalPages) {
        multipageNote = `only merged ${pagesFetched}/${totalPages} pages`;
      }
    } else {
      multipageNote = `detected ${totalPages} pages but ctx.fetchPage was not provided; returning page 1 only`;
    }
  }

  return {
    sourceId: SOURCE_ID,
    url,
    title,
    author,
    publishedAt,
    updatedAt,
    summary,
    category,
    tags,
    thumbnailUrl,
    externalId,
    paragraphs,
    multipage: { totalPages, pagesFetched, note: multipageNote },
    rawHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for smoke tests / debugging without hitting the network:
  FIXTURE_PATH,
  FIXTURE_PATH_PAGE2,
  discoverLive,
  extractArticleParagraphs,
  parseTotalPages,
};
