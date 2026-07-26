'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');
const { takeUntilOverlapCutoff } = require('../../core/overlap');

/**
 * Detik (detik.com) adapter — LIVE implementation ("detik_v1_live").
 *
 * Field matrix (field -> extraction source, in fallback order):
 *   title             -> JSON-LD NewsArticle.headline > .detail__title > og:title > <title>
 *   author_name       -> JSON-LD NewsArticle.author.name > .detail__author DOM text (strips
 *                        the trailing " - detikXxx" section label)
 *   published_at      -> JSON-LD NewsArticle.datePublished > .detail__date time[datetime]
 *                        (best-effort; left undefined if neither is present/parseable)
 *   updated_at        -> JSON-LD NewsArticle.dateModified
 *   summary           -> JSON-LD NewsArticle.description > meta[name="description"]
 *   thumbnail_url     -> JSON-LD NewsArticle.image.url > meta[property="og:image"]
 *   canonical url     -> link[rel="canonical"] > meta[property="og:url"] >
 *                        JSON-LD mainEntityOfPage["@id"]
 *   category          -> first path segment of the resolved URL (e.g. "berita",
 *                        "berita-ekonomi-bisnis") — cheap, works across every Detik vertical
 *   tags              -> .detail__body-tag a[] text (best-effort, often empty)
 *   external_article_id -> "d-<digits>" segment parsed out of the URL
 *   content (paragraphs) -> .detail__body-text/.itp_bodycontent <p>, after stripping known
 *                        noise (<script>/<style>, .noncontent "Baca juga" blocks,
 *                        .parallaxindetail ad/scroll widgets, .detail__body-tag list,
 *                        div-gpt-ad slots, <iframe>); a leading bare <strong> dateline
 *                        (e.g. "Jakarta") is folded into the first paragraph as "X - ...".
 *   language          -> hardcoded "id" (Detik is Indonesian-only)
 *
 * `discover()` fetches a live Detik "indeks" (channel index) listing page — default
 * https://news.detik.com/indeks, supports `?page=`/`?date=` (format MM/DD/YYYY, matching the
 * site's own date picker) via `ctx.page`/`ctx.date` — and extracts up to `ctx.limit` (default
 * 8) article URLs matching `isArticleUrl()`, tagged `discoveryChannel: "indeks"`. If the live
 * fetch fails (network/blocked) or yields zero matching URLs (markup drift), it falls back to
 * the small hardcoded `FIXTURE_LISTING` below (`discoveryChannel: "fixture"`) instead of
 * throwing, so callers (crawl-once, workers, smoke tests) keep working offline.
 *
 * `parse()` is fixture-first when no `html` is supplied (or `ctx.fixtureOnly` is set) — it
 * reads the bundled regression fixture (`fixtures/detik/sample-article.html`, which mixes in
 * JSON-LD plus the same ad/"baca juga" noise real pages have) so the fixture path exercises
 * the exact same hybrid JSON-LD + DOM cleanup logic real pages go through.
 */

const SOURCE_ID = 'detik';

const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'fixtures', 'detik', 'sample-article.html');

// Detik article URLs generally look like:
//   https://www.detik.com/berita/d-1234567/judul-artikel-slug
//   https://finance.detik.com/berita-ekonomi-bisnis/d-7654321/judul-lain
//   https://inet.detik.com/... /d-1111111/...
// i.e. some detik.com (sub)domain, with a "/d-<digits>/" segment somewhere in
// the path. This is kept permissive on purpose (any subdomain, any leading
// category segment) since Detik has many verticals (finance, health, sport,
// inet, ...). It intentionally excludes obvious non-article paths like the
// homepage, tag pages, or search pages.
const ARTICLE_URL_PATTERN = /^https?:\/\/([a-z0-9-]+\.)?detik\.com\/.*\/d-\d+([/-].*)?$/i;

const NON_ARTICLE_PATH_PATTERN = /\/(tag|indeks|search|foto|video)\//i;

const EXTERNAL_ID_PATTERN = /\/d-(\d+)(?:[/-]|$)/i;

const DEFAULT_INDEKS_URL = 'https://news.detik.com/indeks';
const DEFAULT_DISCOVER_LIMIT = 8;
const HTTP_TIMEOUT_MS = 15000;
const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';

// Elements stripped from `.detail__body-text` before pulling `<p>` text: ad/scroll widgets,
// "Baca juga" link blocks, inline scripts/styles, GPT ad slots, and the trailing keyword-tag
// list. `.parallaxindetail` already contains the `.ads-scrollpage-*` wrapper divs and the
// "SCROLL TO CONTINUE WITH CONTENT" caption on live pages, but the extra selectors are kept
// as defensive belt-and-suspenders in case a template variant nests them differently.
const BODY_NOISE_SELECTORS = [
  'script',
  'style',
  '.noncontent',
  '.linksisip',
  '.parallaxindetail',
  '[class*="ads-scrollpage"]',
  '[id^="div-gpt-ad"]',
  '.detail__body-tag',
  'iframe',
];

// Fixture "listing" used by discover() as an offline fallback when the live indeks fetch is
// blocked/unavailable, and directly by tests/smoke runs that pass `ctx.fixtureOnly`.
// Newest-first order (matches live indeks + overlap-stop assumption).
const FIXTURE_LISTING = [
  {
    rawUrl: 'https://www.detik.com/berita/d-1234568/contoh-judul-berita-detik-kedua',
    listingTitle: 'Contoh Judul Berita Detik Kedua',
    publishedHint: 'Kamis, 23 Jul 2026 15:10 WIB',
  },
  {
    rawUrl: 'https://www.detik.com/berita/d-1234567/contoh-judul-berita-detik',
    listingTitle: 'Contoh Judul Berita Detik',
    publishedHint: 'Kamis, 23 Jul 2026 14:35 WIB',
  },
];

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Detikcom',
    baseUrl: 'https://www.detik.com/',
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
  if (NON_ARTICLE_PATH_PATTERN.test(url)) {
    return false;
  }
  return ARTICLE_URL_PATTERN.test(url);
}

function fixtureListingItems() {
  return FIXTURE_LISTING.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: entry.rawUrl,
    discoveryChannel: 'fixture',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
  }));
}

/**
 * @param {{baseUrl?: string, page?: string|number, date?: string}} opts - `date` is expected
 *   in the site's own MM/DD/YYYY format (matches the `#form-tanggal` input on the indeks page).
 * @returns {string}
 */
function buildIndeksUrl({ baseUrl = DEFAULT_INDEKS_URL, page, date } = {}) {
  const url = new URL(baseUrl);
  if (page !== undefined && page !== null && page !== '') {
    url.searchParams.set('page', String(page));
  }
  if (date) {
    url.searchParams.set('date', date);
  }
  return url.toString();
}

/**
 * Extracts up to `limit` unique article URLs (in document order) from an indeks listing page.
 * Each article typically appears twice on the page (once as an image-wrapping link, once as
 * the title link) — this keeps the first non-empty anchor text seen for a given href.
 *
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, normalizedUrl: string, discoveryChannel: string, listingTitle?: string}>}
 */
function parseListingHtml(html, limit) {
  const $ = cheerio.load(html);
  const order = [];
  const titleByUrl = new Map();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !isArticleUrl(href)) return;

    if (!titleByUrl.has(href)) {
      titleByUrl.set(href, '');
      order.push(href);
    }

    if (!titleByUrl.get(href)) {
      const text = $(el).text().trim();
      if (text) {
        titleByUrl.set(href, text);
      }
    }
  });

  return order.slice(0, limit).map((rawUrl) => ({
    rawUrl,
    normalizedUrl: rawUrl,
    discoveryChannel: 'indeks',
    listingTitle: titleByUrl.get(rawUrl) || undefined,
  }));
}

/**
 * Playbook §20.2 overlap-window stop condition (Sprint 8, S8-B; Sprint 13 parse fix via
 * `src/core/parseListingDate.js` inside `takeUntilOverlapCutoff` / `isOlderThanCutoff`):
 * stop keeping items once one is confidently older than `ctx.overlapCutoffAt`.
 *
 * Fixture `publishedHint` strings (e.g. "Kamis, 23 Jul 2026 15:10 WIB") now parse, so
 * fixture discover activates mid-list stop when a cutoff falls between items.
 *
 * RESIDUAL (S13-D): live `indeks` markup parsed by `parseListingHtml()` still does not
 * scrape a per-item timestamp, so live-discovered items never carry `publishedHint` and
 * live discover still falls back to `ctx.limit` alone until listing dates are wired in.
 *
 * @param {Array<{publishedHint?: string}>} items
 * @param {{overlapCutoffAt?: string}} [ctx]
 * @param {number} [limit]
 * @returns {Array<Object>}
 */
function applyOverlapStop(items, ctx, limit) {
  const cutoffAt = ctx && ctx.overlapCutoffAt ? new Date(ctx.overlapCutoffAt) : undefined;
  if (!cutoffAt || Number.isNaN(cutoffAt.getTime())) {
    return typeof limit === 'number' && limit > 0 ? items.slice(0, limit) : items;
  }
  return takeUntilOverlapCutoff(items, { cutoffAt, limit, getPublishedHint: (item) => item.publishedHint });
}

/**
 * @param {{indeksUrl?: string, page?: string|number, date?: string, limit?: number,
 *   fixtureOnly?: boolean, overlapCutoffAt?: string, logger?: {warn?: Function}}} [ctx]
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx && ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const logger = (ctx && ctx.logger) || console;

  if (ctx && ctx.fixtureOnly) {
    return { items: applyOverlapStop(fixtureListingItems(), ctx, limit) };
  }

  const indeksUrl = buildIndeksUrl({
    baseUrl: (ctx && ctx.indeksUrl) || DEFAULT_INDEKS_URL,
    page: ctx && ctx.page,
    date: ctx && ctx.date,
  });

  try {
    const response = await axios.get(indeksUrl, {
      headers: { 'User-Agent': CRAWLER_UA },
      timeout: HTTP_TIMEOUT_MS,
    });

    const items = parseListingHtml(response.data, limit);
    if (items.length > 0) {
      return { items: applyOverlapStop(items, ctx, limit) };
    }

    if (typeof logger.warn === 'function') {
      logger.warn(
        `[detik] discover(): live indeks fetch returned 0 matching article URL(s) from ${indeksUrl}; falling back to fixture listing`
      );
    }
  } catch (err) {
    if (typeof logger.warn === 'function') {
      logger.warn(`[detik] discover(): live indeks fetch failed (${err.message}); falling back to fixture listing`);
    }
  }

  return { items: applyOverlapStop(fixtureListingItems(), ctx, limit) };
}

/**
 * @param {string} raw - JSON-LD script text.
 * @returns {object[]} flattened list of JSON-LD nodes found (handles bare objects, arrays,
 *   and `{ "@graph": [...] }` wrappers). Malformed blocks are skipped rather than thrown.
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

function categoryFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.split('/').filter(Boolean)[0] || undefined;
  } catch (_err) {
    return undefined;
  }
}

function extractAuthorName(articleLd, $) {
  const ldAuthor = articleLd && articleLd.author;
  if (ldAuthor) {
    if (typeof ldAuthor.name === 'string' && ldAuthor.name.trim()) return ldAuthor.name.trim();
    if (Array.isArray(ldAuthor) && ldAuthor[0] && typeof ldAuthor[0].name === 'string') {
      return ldAuthor[0].name.trim();
    }
  }
  const domAuthor = $('.detail__author').first().text().trim();
  if (!domAuthor) return undefined;
  // DOM byline is typically "Author Name - detikXxx"; keep only the name portion.
  return domAuthor.split(' - ')[0].trim() || undefined;
}

/**
 * Removes known noise (ads, "Baca juga", scripts/styles, tag list) from a clone of the
 * article body, then returns the cleaned-up `<p>` text as paragraphs. A leading bare
 * `<strong>` dateline (e.g. "Jakarta") is folded into the first paragraph as "Dateline - ...".
 *
 * @param {cheerio.Cheerio} bodyEl
 * @returns {string[]}
 */
function extractParagraphs($, bodyEl) {
  if (!bodyEl || bodyEl.length === 0) return [];

  const cleaned = bodyEl.clone();
  cleaned.find(BODY_NOISE_SELECTORS.join(', ')).remove();

  const paragraphs = cleaned
    .find('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);

  // Only treat a <strong> as a "Jakarta -"-style dateline if it is the very first element
  // child of the body (real Detik pages put it before any <p>); a byline sign-off like
  // "(tim/tim)" further down (also a bare <strong>) must NOT be picked up here.
  const firstChild = cleaned.children().first();
  const isLeadingStrong = firstChild.length > 0 && firstChild.get(0).tagName === 'strong';
  const dateline = isLeadingStrong ? firstChild.text().trim() : '';
  if (
    dateline &&
    dateline.length <= 40 &&
    paragraphs.length > 0 &&
    !paragraphs[0].toLowerCase().startsWith(dateline.toLowerCase())
  ) {
    paragraphs[0] = `${dateline} - ${paragraphs[0]}`;
  }

  return paragraphs;
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? fs.readFileSync(FIXTURE_PATH, 'utf8') : html;

  const $ = cheerio.load(rawHtml);
  const ldBlocks = extractJsonLd($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && articleLd.mainEntityOfPage['@id']) ||
    FIXTURE_LISTING[0].rawUrl;

  const title =
    articleLd.headline ||
    $('.detail__title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author = extractAuthorName(articleLd, $);

  const publishedAt =
    toIsoOrUndefined(articleLd.datePublished) || toIsoOrUndefined($('.detail__date time').attr('datetime'));

  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const summary = articleLd.description || $('meta[name="description"]').attr('content') || undefined;

  const ldImage = articleLd.image;
  const thumbnailUrl =
    (ldImage && (typeof ldImage === 'string' ? ldImage : ldImage.url)) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const externalMatch = EXTERNAL_ID_PATTERN.exec(url);
  const externalArticleId = externalMatch ? `d-${externalMatch[1]}` : undefined;

  const category = categoryFromUrl(url);

  const tags = $('.detail__body-tag a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);

  const bodyEl = $('.detail__body-text').first().length
    ? $('.detail__body-text').first()
    : $('.itp_bodycontent').first();

  const paragraphs = extractParagraphs($, bodyEl);

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
  // exported for unit tests / debugging in isolation.
  buildIndeksUrl,
  parseListingHtml,
};
