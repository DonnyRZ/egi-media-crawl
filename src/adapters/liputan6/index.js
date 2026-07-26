'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Liputan6 (liputan6.com) adapter — Sprint 3 (S3-B), same camelCase raw-stub pattern as
 * `src/adapters/detik/index.js` / `src/adapters/viva/index.js`. `./coreAdapter.js` bridges
 * this to the snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (task brief, verified live 2026-07-24):
 *  - crawlable / go-with-limits. Scope restricted to the bare `www.liputan6.com` host ONLY.
 *    Liputan6 has several (sub)domain "verticals" that look similar but are OUT of scope
 *    here (e.g. `enamplus.liputan6.com` for TV/video, `berita.liputan6.com`) — these are
 *    NOT just CDN hosts (the CDN itself lives on a completely different domain,
 *    `*.akamaized.net`, so it was never a collision risk), but they are separate article
 *    hosts with their own templates that this adapter has not been verified against.
 *    `isArticleUrl()` enforces the `www.liputan6.com` host directly in `ARTICLE_URL_PATTERN`.
 *  - Discovery: `https://www.liputan6.com/{channel}/indeks` is NOT usable for SSR discovery
 *    — verified live, it renders only a client-side date-range picker with no default
 *    listing in the HTML (results are fetched via JS after the user picks a date range).
 *    Instead, discovery uses the channel landing page itself (default
 *    `https://www.liputan6.com/news`, override via `ctx.channelUrl`), which DOES
 *    server-render a real listing (`.headline--bottom-slider__list` > `.headline--bottom-
 *    slider__item[data-article-id][data-channel][data-category]` > `a[href][title]` +
 *    `time[datetime]` ISO8601-with-offset + `.headline--bottom-slider__item_title`).
 *  - Article URL shape: `https://www.liputan6.com/{channel}/read/{numericId}/{slug}`, e.g.
 *      https://www.liputan6.com/news/read/8253586/tak-ada-phk-di-telkom-dasco-kawal-...
 *      https://www.liputan6.com/bisnis/read/8252821/sibuk-kembangkan-ai-amazon-...
 *    `{channel}` values like `photo`/`foto`/`video` are gallery/video content types (no
 *    `.article-content-body` text body) and are excluded by `NON_ARTICLE_PATH_PATTERN`,
 *    same treatment as detik/suara's `/foto/`,`/video/` exclusions.
 *  - Article page is hybrid: JSON-LD `NewsArticle` (headline/dates/author/image/
 *    description, but NO `articleBody`) + DOM for everything else. No `<link
 *    rel="canonical">` tag was observed live — `og:url` is the primary canonical source.
 *  - **CRITICAL — multipage is same-document, not same-URL-different-page**: unlike
 *    detik/viva/suara (which paginate via a separate `?page=N` HTTP request per page),
 *    Liputan6 server-renders EVERY page of a multipage article into ONE HTML response as
 *    sibling `.article-content-body__item-page[data-page="N"]` blocks inside a single
 *    `.article-content-body` container (verified live: a 2-page article had both
 *    `data-page="1"` and `data-page="2"` blocks in the same response, the second carrying
 *    a `data-title`/`<h2>` sub-heading). `parse()` therefore never performs any extra
 *    network I/O for pagination — it just walks every `[data-page]` block already present
 *    in the fetched `html` and merges their paragraphs in `data-page` order. See
 *    `extractMergedContent()` below, and `fixtures/liputan6/sample-article.html` for a
 *    fixture that fails obviously if this merge is ever accidentally removed.
 *  - `summary` <- JSON-LD `description` > `og:description` > `meta[name=description]` >
 *    DOM `.read-page--header--description p`.
 *  - `thumbnailUrl` <- JSON-LD `image.url` > `og:image`.
 *  - `tags` <- `meta[name="keywords"]` (comma-separated); no reliable per-article tag DOM
 *    list was found live (same gap as VIVA — tracked, not invented).
 *  - `category` <- DOM breadcrumb's last (most specific) item text (e.g. "Politik") >
 *    URL `{channel}` segment.
 *  - `publishedAt`/`updatedAt` <- JSON-LD `datePublished`/`dateModified` > `meta[property=
 *    "article:published_time"/"article:modified_time"]` (both present live with a
 *    `+07:00` offset, so no naive-timezone guessing is needed here unlike suara).
 *
 * SAFETY: `discover()`'s live channel-page fetch only runs when `process.env.CRAWL_LIVE ===
 * 'true'` (same convention as `src/workers/lib/fetchHtml.js` / viva's `isLiveCrawlEnabled`);
 * otherwise it reads the bundled `fixtures/liputan6/channel-news.html` fixture. `parse()`
 * never performs network I/O at all (no extra-page fetch is ever needed, per the multipage
 * note above), so it is safe to call directly against fixture HTML with no live gating.
 */

const SOURCE_ID = 'liputan6';
const BASE_URL = 'https://www.liputan6.com/';
const DEFAULT_CHANNEL_URL = 'https://www.liputan6.com/news';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'liputan6');
const FIXTURE_CHANNEL_PATH = path.join(FIXTURES_DIR, 'channel-news.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8;

// Article URLs: https://www.liputan6.com/{channel}/read/{numericId}[/{slug}][?query]
// Host is pinned to www.liputan6.com on purpose — see module header ("Scope" note).
const ARTICLE_URL_PATTERN =
  /^https?:\/\/www\.liputan6\.com\/[a-z0-9-]+\/read\/\d+(?:\/[a-z0-9-]+)?\/?(?:\?.*)?$/i;

// /photo, /foto, /video are gallery/video content types (no `.article-content-body` text
// body this adapter can parse) — same treatment as detik's stub. /indeks/tag/search/author
// are listing/utility pages, kept here defensively even though they don't structurally
// match ARTICLE_URL_PATTERN's "/read/<id>" shape anyway.
const NON_ARTICLE_PATH_PATTERN = /\/(indeks|tag|search|author|photo|foto|video)\//i;

const EXTERNAL_ID_PATTERN = /\/read\/(\d+)(?:[/?]|$)/i;

// Elements stripped from `.article-content-body__item-content` before pulling `<p>` text:
// "Baca Juga" recirculation blocks and inline scripts/styles/ad markup. Applied per
// data-page block inside extractMergedContent() (real ad slots on the live page are
// siblings of `.article-content-body__item-page`, not nested inside it, so they are
// already excluded just by scoping the selector — this list is defensive belt-and-
// suspenders for any nested variant).
const BODY_NOISE_SELECTORS = ['script', 'style', '.baca-juga-collections', '.article-ad', 'iframe', 'ins'];

function isLiveCrawlEnabled() {
  return process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Liputan6.com',
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
 * Defensive strip of a `page` query param before using a URL as `canonical_url`. Liputan6
 * doesn't use `?page=` at all (multipage is same-document, see module header), but this
 * mirrors the invariant every other adapter in this repo defends (viva/detik/suara), in
 * case a tracking/query variant of a Liputan6 URL is ever seen in the wild.
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function stripPageParam(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('page');
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  const match = EXTERNAL_ID_PATTERN.exec(url);
  return match ? match[1] : undefined;
}

function categoryFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.split('/').filter(Boolean)[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts up to `limit` unique in-scope article entries (in document order) from a
 * channel-page listing (`.headline--bottom-slider__item`). Shared by both the fixture and
 * live discovery paths so the extraction logic is identical either way.
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, externalId?: string, categoryHint?: string}>}
 */
function parseListingHtml(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('.headline--bottom-slider__item').each((_, el) => {
    if (items.length >= limit) return;
    const $item = $(el);
    const $link = $item.find('a[href]').first();
    const href = $link.attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    const listingTitle =
      $item.find('.headline--bottom-slider__item_title').first().text().trim() ||
      $link.attr('title') ||
      undefined;
    const publishedHint = $item.find('time[datetime]').first().attr('datetime') || undefined;
    const categoryHint = $item.attr('data-category') || undefined;

    items.push({
      rawUrl: href,
      listingTitle,
      publishedHint,
      externalId: $item.attr('data-article-id') || extractExternalId(href),
      categoryHint,
    });
  });

  return items;
}

/**
 * @param {{channelUrl?: string, limit?: number, fixtureOnly?: boolean, logger?: {warn?: Function}}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx && ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const logger = (ctx && ctx.logger) || console;

  if (!isLiveCrawlEnabled() || (ctx && ctx.fixtureOnly)) {
    const entries = parseListingHtml(readFixture(FIXTURE_CHANNEL_PATH), limit);
    return {
      items: entries.map((entry) => ({
        rawUrl: entry.rawUrl,
        normalizedUrl: stripPageParam(entry.rawUrl),
        discoveryChannel: 'fixture',
        listingTitle: entry.listingTitle,
        publishedHint: entry.publishedHint,
        externalId: entry.externalId,
        categoryHint: entry.categoryHint,
      })),
    };
  }

  const channelUrl = (ctx && ctx.channelUrl) || DEFAULT_CHANNEL_URL;

  try {
    const response = await axios.get(channelUrl, {
      headers: { 'User-Agent': CRAWLER_UA },
      timeout: HTTP_TIMEOUT_MS,
    });

    const entries = parseListingHtml(response.data, limit);
    if (entries.length > 0) {
      return {
        items: entries.map((entry) => ({
          rawUrl: entry.rawUrl,
          normalizedUrl: stripPageParam(entry.rawUrl),
          discoveryChannel: 'channel_page',
          listingTitle: entry.listingTitle,
          publishedHint: entry.publishedHint,
          externalId: entry.externalId,
          categoryHint: entry.categoryHint,
        })),
      };
    }

    if (typeof logger.warn === 'function') {
      logger.warn(
        `[liputan6] discover(): live channel fetch returned 0 matching article URL(s) from ${channelUrl}; falling back to fixture listing`
      );
    }
  } catch (err) {
    if (typeof logger.warn === 'function') {
      logger.warn(`[liputan6] discover(): live channel fetch failed (${err.message}); falling back to fixture listing`);
    }
  }

  const fallbackEntries = parseListingHtml(readFixture(FIXTURE_CHANNEL_PATH), limit);
  return {
    items: fallbackEntries.map((entry) => ({
      rawUrl: entry.rawUrl,
      normalizedUrl: stripPageParam(entry.rawUrl),
      discoveryChannel: 'fixture',
      listingTitle: entry.listingTitle,
      publishedHint: entry.publishedHint,
      externalId: entry.externalId,
      categoryHint: entry.categoryHint,
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
  } catch {
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

function extractAuthorName(articleLd, $) {
  const ldAuthor = articleLd && articleLd.author;
  if (ldAuthor) {
    if (Array.isArray(ldAuthor) && ldAuthor[0] && typeof ldAuthor[0].name === 'string') {
      return ldAuthor[0].name.trim();
    }
    if (typeof ldAuthor.name === 'string' && ldAuthor.name.trim()) return ldAuthor.name.trim();
  }
  const domAuthor = $('.read-page-box__author__name').first().text().trim();
  return domAuthor || undefined;
}

/**
 * Extracts the article's category from the breadcrumb trail (most specific/last item,
 * e.g. "Politik" for Home > News > Politik), falling back to the URL's `{channel}` path
 * segment (e.g. "news") if the breadcrumb is missing/malformed.
 * @param {cheerio.CheerioAPI} $
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function extractCategory($, url) {
  const breadcrumbItems = $('.read-page--breadcrumb--item__title span')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  if (breadcrumbItems.length > 0) {
    return breadcrumbItems[breadcrumbItems.length - 1];
  }
  return categoryFromUrl(url);
}

/**
 * **CRITICAL** (see module header "Multipage is same-document"): finds every
 * `.article-content-body__item-page[data-page]` block in the document — there may be just
 * one (single-page article) or several (multipage) — sorts them by their numeric
 * `data-page` attribute (defensive against DOM order drift; real pages are already emitted
 * in order), and merges each block's cleaned `<p>` text into one paragraph list. A
 * non-empty `data-title` on a block (Liputan6 renders this as an `<h2>` sub-heading for
 * page 2+) is included as its own paragraph-like entry immediately before that block's
 * body text, so the sub-heading isn't silently dropped.
 *
 * @param {cheerio.CheerioAPI} $
 * @returns {{paragraphs: string[], pagesMerged: number}}
 */
function extractMergedContent($) {
  const blocks = $('.article-content-body__item-page')
    .toArray()
    .map((el) => {
      const pageNum = parseInt($(el).attr('data-page'), 10);
      return { el, page: Number.isFinite(pageNum) ? pageNum : 0 };
    })
    .sort((a, b) => a.page - b.page);

  const paragraphs = [];
  for (const { el } of blocks) {
    const $block = $(el);
    const pageTitle = ($block.attr('data-title') || '').trim();
    if (pageTitle) {
      paragraphs.push(pageTitle);
    }

    const $content = $block.find('.article-content-body__item-content').first().clone();
    $content.find(BODY_NOISE_SELECTORS.join(', ')).remove();
    $content
      .find('p')
      .each((_, p) => {
        const text = $(p).text().trim();
        if (text) paragraphs.push(text);
      });
  }

  return { paragraphs, pagesMerged: blocks.length };
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);
  const ldBlocks = extractJsonLd($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && articleLd.mainEntityOfPage['@id']) ||
    undefined;
  const canonicalUrl = url ? stripPageParam(url) : undefined;

  const title =
    articleLd.headline ||
    $('.read-page--header--title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author = extractAuthorName(articleLd, $);

  const publishedAt =
    toIsoOrUndefined(articleLd.datePublished) ||
    toIsoOrUndefined($('meta[property="article:published_time"]').attr('content'));

  const updatedAt =
    toIsoOrUndefined(articleLd.dateModified) ||
    toIsoOrUndefined($('meta[property="article:modified_time"]').attr('content'));

  const summary =
    articleLd.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('.read-page--header--description p').first().text().trim() ||
    undefined;

  const ldImage = articleLd.image;
  const thumbnailUrl =
    (ldImage && (typeof ldImage === 'string' ? ldImage : ldImage.url)) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const externalId = extractExternalId(canonicalUrl || url || '') || $('article[data-article-id]').attr('data-article-id');

  const category = extractCategory($, canonicalUrl || url);

  const keywordsContent = $('meta[name="keywords"]').attr('content') || '';
  const tags = keywordsContent
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const { paragraphs, pagesMerged } = extractMergedContent($);

  return {
    sourceId: SOURCE_ID,
    url: canonicalUrl,
    title,
    author,
    publishedAt,
    updatedAt,
    summary,
    thumbnailUrl,
    category,
    tags,
    externalArticleId: externalId,
    paragraphs,
    pagesMerged,
    rawHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/liputan6/smoke-test.js) and
  // for debugging extraction logic in isolation.
  parseListingHtml,
  extractMergedContent,
  extractExternalId,
  stripPageParam,
  isLiveCrawlEnabled,
  FIXTURE_CHANNEL_PATH,
  FIXTURE_ARTICLE_PATH,
};
