'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * CNN Indonesia (cnnindonesia.com) adapter — Sprint 3 (S3-A). camelCase raw adapter,
 * following the same fixture-first pattern as `src/adapters/detik/index.js` /
 * `src/adapters/suara/index.js`. `src/adapters/cnn_indonesia/coreAdapter.js` bridges this to
 * the snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (task brief):
 *  - crawlable / go-with-limits. Scope restricted to the bare `www.cnnindonesia.com` host
 *    only (no subdomains — CNN Indonesia shares its login stack with `connect.detik.com`
 *    but that is out of scope here).
 *  - Discovery: `https://www.cnnindonesia.com/indeks`, supports `?page=N` (verified live
 *    2026-07-24 — page 2/3 return distinct, older articles) and `?date=DD/MM/YYYY` (the
 *    site's own datepicker format, `dateFormat: "dd/MM/yyyy"`; passed through best-effort —
 *    live testing did not observe the listing actually change with this param, so treat it
 *    as unverified/optional exactly like `date` on the Detik adapter). `discover()` defaults
 *    to a small offline fixture listing (network-free); pass `ctx.liveDiscover = true` (or
 *    set `CRAWL_LIVE=true`) to opt into a live fetch, same convention as `suara/index.js`.
 *  - Article URL shape: `/{kanal}/{YYYYMMDDHHmmss}-{kanalId}-{articleId}/{slug}`, e.g.
 *      https://www.cnnindonesia.com/ekonomi/20260724100745-78-1384410/judul-artikel-slug
 *    `{kanal}` is the vertical (ekonomi, nasional, internasional, olahraga, tv, ...);
 *    `{articleId}` (the last numeric segment) is stable and reused as `external_article_id`.
 *  - Article page is hybrid, and CNN Indonesia's markup is effectively Detik's own template
 *    (same `connect.detik.com` auth, same `akcdn.detik.net.id` image CDN):
 *      - JSON-LD: a `WebPage` block (headline/datePublished/image) plus a `NewsArticle`
 *        block (mainEntityOfPage/dates/author/image/publisher/description) — verified live
 *        2026-07-24 that `NewsArticle.author.name` is frequently an empty string, so the DOM
 *        byline (`.text-cnn_black_light3 span`, usually just "CNN Indonesia") is the more
 *        reliable — if still brand-only — source. Per assessment notes ("Author often brand
 *        — optional weak OK") this field is treated as low-confidence/optional either way.
 *      - Body text lives only in DOM `.detail-text` (verified live selector, matches the
 *        assessment notes' `.detail-text` hint) — no `articleBody` in JSON-LD.
 *  - `summary` <- JSON-LD `description` > `og:description` > `meta[name=description]`.
 *  - `thumbnailUrl` <- JSON-LD `image`/`image.url` > `og:image`.
 *  - `category` <- breadcrumb DOM `a.gtm_breadcrumb_kanal` text > `{kanal}` URL segment.
 *  - `tags` <- the "TOPIK TERKAIT" `<aside>` link text (verified live selector; the inline
 *    `/tag/` links inside `.detail-text` itself are keyword highlights, not the tag list, so
 *    tag extraction is deliberately scoped to the aside whose `.title-box` reads "TOPIK
 *    TERKAIT" rather than a blanket `a[href*="/tag/"]` selector).
 *  - Cleanup before extracting body paragraphs (mirrors Detik's noise list almost exactly,
 *    since it is the same underlying CMS template): `.linksisip` ("Lihat Juga" tables),
 *    `.paradetail` (parallax/scroll ad wrapper + "SCROLL TO CONTINUE WITH CONTENT" caption),
 *    `[id^="div-gpt-ad"]` slots, `.newstag`, `.end-of-article`, the "Add as a preferred
 *    source on Google" link, `<script>`/`<style>`/`<iframe>`, `<ins>` ad tags.
 *  - A leading bare `<strong>` dateline (e.g. "Jakarta, CNN Indonesia") before the first
 *    `<p>` is folded into the first paragraph, same treatment as Detik's stub; a trailing
 *    bare `<strong>` sign-off (e.g. "(lau/pta)") is excluded from paragraphs entirely (it's
 *    an internal desk code, not article content).
 *  - No live multipage markup was found on the sampled live article (no `.pagination-detail`
 *    equivalent) — `parse()` still defensively strips any `?page=` query param before using a
 *    URL as `canonical_url` (mirrors `viva/index.js`'s `stripPageParam`, per the task's
 *    "strip ?page= on canonical if multipage" instruction), in case some article template
 *    variant does paginate.
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as `suara/index.js`); otherwise it
 * returns the bundled fixture listing. `parse()` is fixture-first when no `html` is supplied
 * (or `ctx.fixtureOnly` is set), reading `fixtures/cnn_indonesia/sample-article.html`.
 */

const SOURCE_ID = 'cnn_indonesia';
const BASE_URL = 'https://www.cnnindonesia.com/';
const ALLOWED_HOST = 'www.cnnindonesia.com';
const INDEKS_URL = 'https://www.cnnindonesia.com/indeks';

const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'fixtures', 'cnn_indonesia', 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';

const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range
const HTTP_TIMEOUT_MS = 15000;

// CNN Indonesia article URLs: https://www.cnnindonesia.com/{kanal}/{14-digit-timestamp}-{kanalId}-{articleId}/{slug}
// Host is pinned to www.cnnindonesia.com on purpose (per assessment notes' scope).
const ARTICLE_URL_PATTERN =
  /^https?:\/\/www\.cnnindonesia\.com\/[a-z0-9-]+\/\d{14}-\d+-\d+\/[a-z0-9-]+\/?(?:\?.*)?$/i;

// /indeks (+sub-listings like /indeks/foto/2), /tag, /search, /tentang-kami, and the
// outbound-link redirector are listing/utility pages, never article bodies.
const NON_ARTICLE_PATH_PATTERN = /\/(indeks|tag|search|tentang-kami|outboundlinks)(\/|$|\?)/i;

const EXTERNAL_ID_PATTERN = /\/\d{14}-\d+-(\d+)\//;

// Elements stripped from `.detail-text` before pulling `<p>` text — see module header for
// rationale (this is effectively the same underlying CMS template as Detik).
const BODY_NOISE_SELECTORS = [
  'script',
  'style',
  'iframe',
  'ins',
  '.linksisip',
  '.paradetail',
  '[id^="div-gpt-ad"]',
  '.newstag',
  '.end-of-article',
  'a.border', // "Add as a preferred source on Google" widget
];

// Fixture "listing" used by discover() when live discovery isn't requested. Mirrors what a
// real `/indeks` crawl would surface; parse() reads the bundled fixture file for the first
// entry regardless of the URL passed in (network-free default, same as detik/suara).
const FIXTURE_LISTING = [
  {
    rawUrl: 'https://www.cnnindonesia.com/ekonomi/20260724100745-78-1234567/contoh-judul-berita-cnn-indonesia',
    listingTitle: 'Contoh Judul Berita CNN Indonesia',
    publishedHint: '2026-07-24 10:47:05',
    categoryHint: 'ekonomi',
  },
  {
    rawUrl: 'https://www.cnnindonesia.com/nasional/20260724085405-36-1234568/contoh-judul-berita-cnn-indonesia-kedua',
    listingTitle: 'Contoh Judul Berita CNN Indonesia Kedua',
    publishedHint: '2026-07-24 08:54:05',
    categoryHint: 'nasional',
  },
];

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'CNN Indonesia',
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

function isInScope(absoluteUrl) {
  try {
    return new URL(absoluteUrl).hostname.toLowerCase() === ALLOWED_HOST;
  } catch (_err) {
    return false;
  }
}

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

/**
 * @param {string} url
 * @returns {string|undefined} numeric `articleId` segment (the last of the three dash-joined
 *   tokens in the URL's second path segment).
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  const match = EXTERNAL_ID_PATTERN.exec(url);
  return match ? match[1] : undefined;
}

/**
 * @param {string} url
 * @returns {string|undefined} the `{kanal}` path segment, used as a discovery-time category
 *   hint (low confidence — the real category should come from the article page's breadcrumb
 *   once parsed).
 */
function extractChannelHint(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.split('/').filter(Boolean)[0] || undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url` (mirrors
 * `viva/index.js`'s `stripPageParam` — see module header on why this is defensive rather than
 * observed-necessary for CNN Indonesia).
 * @param {string} url
 * @returns {string}
 */
function stripPageParam(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('page');
    return parsed.toString();
  } catch (_err) {
    return url;
  }
}

/**
 * @param {{page?: string|number, date?: string}} opts - `date` expected in the site's own
 *   `dd/MM/yyyy` datepicker format.
 * @returns {string}
 */
function buildIndeksUrl({ page, date } = {}) {
  const url = new URL(INDEKS_URL);
  if (page !== undefined && page !== null && page !== '') {
    url.searchParams.set('page', String(page));
  }
  if (date) {
    url.searchParams.set('date', date);
  }
  return url.toString();
}

/**
 * Parses an `/indeks` listing page into discovery entries. Each entry is an
 * `<article class="flex-grow"><a href="..."><h2>title</h2>...<span class="text-cnn_red">kanal
 * label</span><span class="text-cnn_black_light3"> • N menit yang lalu<!--YYYY-MM-DD
 * HH:mm:ss--> </span></a></article>` (verified live 2026-07-24). The listing's relative time
 * label ("N menit yang lalu") is not itself parseable, but the HTML comment immediately after
 * it carries the real absolute timestamp — extracted directly from that span's inner HTML.
 * @param {string} html
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, externalId?: string, categoryHint?: string}>}
 */
function extractIndeksItems(html) {
  const $ = cheerio.load(html);

  return $('article.flex-grow')
    .map((_, el) => {
      const $article = $(el);
      const $anchor = $article.find('a[href]').first();
      const href = $anchor.attr('href');
      if (!href || !isInScope(href) || !isArticleUrl(href)) return null;

      const listingTitle = $anchor.find('h2').first().text().trim() || undefined;
      const categoryHint =
        $anchor.find('span.text-cnn_red').first().text().trim() || extractChannelHint(href);

      const timeSpanHtml = $anchor.find('span.text-cnn_black_light3').first().html() || '';
      const commentMatch = /<!--\s*([^>]*?)\s*-->/.exec(timeSpanHtml);
      const publishedHint = commentMatch ? commentMatch[1].trim() : undefined;

      return {
        rawUrl: href,
        listingTitle,
        publishedHint,
        externalId: extractExternalId(href),
        categoryHint,
      };
    })
    .get()
    .filter(Boolean);
}

/**
 * @param {{limit?: number, discoverLimit?: number, page?: string|number, date?: string,
 *   logger?: Object}} [ctx] - `limit` (the `ctx.limit` convention shared with detik/viva/
 *   suara) takes priority; `discoverLimit` is kept as a back-compat alias.
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const indeksUrl = buildIndeksUrl({ page: ctx && ctx.page, date: ctx && ctx.date });

  const response = await axios.get(indeksUrl, {
    headers: { 'User-Agent': CRAWLER_UA },
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'text',
  });

  if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
    return { items: [] };
  }

  const entries = extractIndeksItems(response.data).slice(0, limit);
  const items = entries.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: stripPageParam(entry.rawUrl),
    discoveryChannel: 'indeks',
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
        ctx.logger.warn(`cnn_indonesia discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  const items = FIXTURE_LISTING.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: entry.rawUrl,
    discoveryChannel: 'fixture',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    externalId: extractExternalId(entry.rawUrl),
    categoryHint: entry.categoryHint,
  }));

  return { items };
}

/**
 * Finds the `NewsArticle` JSON-LD block among all `<script type="application/ld+json">`
 * blocks on the page (CNN Indonesia emits several: a bare `WebPage` block, `NewsArticle`, and
 * `BreadcrumbList`). Tolerates `@graph`-wrapped payloads defensively even though CNN Indonesia
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
    } catch (_err) {
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

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {Object|undefined} jsonLd
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined} best-effort author/byline. Per assessment notes ("Author often
 *   brand — optional weak OK") this is frequently just the outlet's own name (e.g. "CNN
 *   Indonesia"), never rejected/blocked on that basis.
 */
function extractAuthorName(jsonLd, $) {
  const ldName = jsonLd && jsonLd.author && jsonLd.author.name;
  if (typeof ldName === 'string' && ldName.trim()) {
    return ldName.trim();
  }
  const domByline = $('.text-cnn_black_light3 span').first().text().trim();
  return domByline || undefined;
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined} breadcrumb kanal label (e.g. "Ekonomi"), from
 *   `a.gtm_breadcrumb_kanal` (verified live selector).
 */
function extractCategory($) {
  return $('a.gtm_breadcrumb_kanal').first().text().trim() || undefined;
}

/**
 * Extracts the "TOPIK TERKAIT" tag list. Deliberately scoped to the `<aside>` whose
 * `.title-box` reads "TOPIK TERKAIT" rather than a blanket `a[href*="/tag/"]` selector,
 * because `.detail-text` itself also contains inline `/tag/` keyword-highlight links that are
 * NOT the article's tag list (see module header).
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractTags($) {
  let tags = [];
  $('aside').each((_, el) => {
    const $aside = $(el);
    const label = $aside.find('.title-box').first().text().trim().toUpperCase();
    if (label.includes('TOPIK TERKAIT')) {
      tags = $aside
        .find('a[href*="/tag/"]')
        .map((__, a) => $(a).text().trim())
        .get()
        .filter(Boolean);
    }
  });
  return tags;
}

/**
 * Removes known noise (ads, "Lihat Juga" tables, scripts/styles) from a clone of the article
 * body, then returns the cleaned-up `<p>` text as paragraphs. A leading bare `<strong>`
 * dateline (e.g. "Jakarta, CNN Indonesia") is folded into the first paragraph as "X - ...";
 * a trailing bare `<strong>` desk sign-off (e.g. "(lau/pta)") is dropped entirely.
 * @param {cheerio.CheerioAPI} $
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

  // Only treat a <strong> as a "Jakarta, CNN Indonesia --"-style dateline if it is the very
  // first element child of the body (matches live markup); a trailing desk sign-off further
  // down (also a bare <strong>, e.g. "(lau/pta)") must NOT be picked up here.
  const firstChild = cleaned.children().first();
  const isLeadingStrong = firstChild.length > 0 && firstChild.get(0).tagName === 'strong';
  const dateline = isLeadingStrong ? firstChild.text().trim() : '';
  if (
    dateline &&
    dateline.length <= 40 &&
    paragraphs.length > 0 &&
    !paragraphs[0].toLowerCase().startsWith(dateline.toLowerCase())
  ) {
    paragraphs[0] = `${dateline} -- ${paragraphs[0]}`;
  }

  return paragraphs;
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? fs.readFileSync(FIXTURE_PATH, 'utf8') : html;

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
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author = extractAuthorName(jsonLd, $);

  const publishedAt = toIsoOrUndefined(jsonLd && jsonLd.datePublished);
  const updatedAt = toIsoOrUndefined(jsonLd && jsonLd.dateModified);

  const summary =
    (jsonLd && jsonLd.description) ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const ldImage = jsonLd && jsonLd.image;
  const thumbnailUrl =
    (ldImage && (typeof ldImage === 'string' ? ldImage : ldImage.url)) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const externalArticleId = extractExternalId(url) || undefined;
  const category = extractCategory($) || extractChannelHint(url);
  const tags = extractTags($);

  const bodyEl = $('.detail-text').first();
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
  // exported for unit tests / offline smoke script (fixtures/cnn_indonesia/smoke-test.js) and
  // for debugging extraction logic in isolation.
  buildIndeksUrl,
  extractIndeksItems,
  extractExternalId,
  extractChannelHint,
  extractNewsArticleJsonLd,
  extractParagraphs,
  extractTags,
  extractCategory,
  stripPageParam,
  discoverLive,
  isLiveDiscoverEnabled,
};
