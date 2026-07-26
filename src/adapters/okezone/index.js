'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Okezone (okezone.com) adapter — Sprint 5 (S5-A). camelCase raw adapter, following the same
 * fixture-first pattern as `src/adapters/detik/index.js` / `src/adapters/tempo/index.js` /
 * `src/adapters/jawa_pos/index.js`. `./coreAdapter.js` bridges this to the snake_case
 * `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct HTTP fetches,
 * plain desktop-browser User-Agent, of `index.okezone.com`, several `{kanal}.okezone.com`
 * hosts, and the site's own robots.txt files):
 *
 *  - **Multi-subdomain, ONE `source_id`**: Okezone is NOT one host — every "kanal" (channel)
 *    is its own subdomain with its OWN template instance (verified live identical markup
 *    across `news.okezone.com`, `bola.okezone.com`, `economy.okezone.com`, `women.okezone.com`,
 *    `sports.okezone.com`, `celebrity.okezone.com`, `ototekno.okezone.com`, `muslim.okezone.com`,
 *    `edukasi.okezone.com`). This adapter treats the whole brand as ONE source
 *    (`source_id: "okezone"`), exactly like `detik/index.js` treats every `*.detik.com`
 *    vertical as one source — NOT a separate adapter per kanal.
 *  - **`allowed_domains` is an explicit allowlist, NOT `*.okezone.com`**: `ALLOWED_ARTICLE_HOSTS`
 *    below lists only the live-verified news-kanal hosts (see `CHANNEL_ID_TO_KANAL_HOST` for
 *    the channelId -> host mapping observed on `index.okezone.com`'s own "INDEKS KANAL" sidebar)
 *    plus `index.okezone.com` itself (discovery-only, never an article host). Two concrete
 *    live-observed reasons this matters:
 *      1. `mpi.okezone.com` is a real okezone.com subdomain (verified live, linked from a
 *         "Baca Juga" block on a real news.okezone.com article) that republishes SINDOnews
 *         (a *different* MNC Media brand) content under `/article/sindonews/{id}` — a blind
 *         `*.okezone.com` allowlist would wrongly ingest another brand's articles as Okezone's.
 *      2. Sibling MNC Media brands entirely off the `okezone.com` apex (e.g. `inews.id`,
 *         `sindonews.com` itself) must never be in scope even if a page links to them — the
 *         explicit host allowlist rejects these by construction (hostname isn't `*.okezone.com`
 *         at all, so it can never match regardless of path shape).
 *      3. `img.okezone.com`/`cdn.okezone.com`/`redaksi.okezone.com` are real okezone.com
 *         subdomains too, but asset/author-profile hosts, not article hosts.
 *  - **Discovery, two live-verified channels** (per task brief; NOT `www.okezone.com/indeks`,
 *    which 404s live — verified):
 *      1. `{kanal}.okezone.com/indeks[/{Y}/{M}/{D}[/{offset}]]` — single-kanal listing.
 *         Verified live on `news.okezone.com/indeks`: page 2's own pagination link is
 *         `/indeks/2026/07/24/10` — i.e. offset increments of **10** per page.
 *      2. `index.okezone.com/bydate/channel/{Y}/{M}/{D}/{channelId}[/{offset}/]` —
 *         cross-channel listing (mixes every kanal when browsed unfiltered from
 *         `index.okezone.com/`, or one kanal at a time via `{channelId}`, see
 *         `CHANNEL_ID_TO_KANAL_HOST`). Verified live pagination links:
 *         `/bydate/channel/2026/07/24/1/15/` (page 2), `/bydate/channel/2026/07/24/1/30/`
 *         (page 3) — i.e. offset increments of **15** per page.
 *  - **Article URL shape** (verified live across all 6 sampled kanal hosts):
 *      `https://{kanal}.okezone.com/read/{YYYY}/{MM}/{DD}/{sectionId}/{articleId}/{slug}`
 *    e.g. `https://news.okezone.com/read/2026/07/24/337/3232094/jamwas-tegaskan-...`,
 *    `https://bola.okezone.com/read/2026/07/24/51/3232091/3-negara-dengan-gelar-...`.
 *    `{articleId}` (the 2nd-to-last path segment) is stable across kanal/subdomain and is
 *    reused as `external_article_id` — verified live it matches the article's own JSON-LD
 *    `mainEntityOfPage["@id"]`.
 *  - **robots.txt**: every sampled kanal host's robots.txt (verified live, `news.okezone.com`
 *    and `bola.okezone.com`) carries `Disallow: /more/*` and `Disallow: /mmore/*` — this
 *    adapter never discovers or fetches those paths (`NON_ARTICLE_PATH_PATTERN` below rejects
 *    them defensively even though they never match `ARTICLE_URL_PATTERN`'s `/read/` shape
 *    anyway).
 *  - Article page is hybrid: JSON-LD `NewsArticle` (headline/dates/author/image/description,
 *    no `articleBody`) + a separate `BreadcrumbList` JSON-LD (last non-"Home" item is the
 *    correctly-cased category, e.g. "Nasional" — the DOM breadcrumb itself is all-caps) + DOM
 *    `.c-detail.read` for the body (verified live, identical class on every sampled kanal).
 *  - **Multipage prefers `?page=all`** (per task brief), not per-page `?page=N` fetches: a
 *    verified-live multipage article's page 1 exposes `#paging .box-nomor a.nomor` (one `<a>`
 *    per page); appending `?page=all` to the canonical URL (verified live) returns every page's
 *    `.c-detail.read` content merged into ONE response, separated by
 *    `<div style="page-break-after: always">` markers, with no `#paging` widget at all. This
 *    is a single extra fetch regardless of page count (cheaper than `N-1` per-page fetches),
 *    resolved by `resolveFullArticleHtml()` below (fixture/`ctx.fetchPage`/live, same three-tier
 *    resolution order as `viva/index.js`'s multipage helper).
 *  - Body noise stripped before extracting `<p>` text: `#baca-juga` ("Baca Juga"
 *    recirculation blocks, verified live present after nearly every paragraph), `.vicon`
 *    (embedded YouTube iframe wrapper), and the `page-break-after` marker divs between merged
 *    `?page=all` pages.
 *  - `tags` <- `#tag .box-tag a` text list (verified live, e.g. "Kasus korupsi", "Kejagung").
 *  - `dateModified` in JSON-LD carries NO timezone (verified live, `"2026-07-24 15:16:40"`,
 *    unlike `datePublished` which does carry an explicit `+07:00`) — `updated_at_source`
 *    assumes WIB (`+07:00`) for this no-tz form, same "no-tz means WIB" convention CNN
 *    Indonesia/Tempo/Jawa Pos already use for their own listing hints.
 *
 * SAFETY: `discover()`'s live fetches and `resolveFullArticleHtml()`'s live `?page=all` fetch
 * only run when `process.env.CRAWL_LIVE === 'true'` (same convention as
 * `src/workers/lib/fetchHtml.js` / every sibling adapter); otherwise bundled fixtures are used
 * and no network I/O occurs. `parse()` itself never performs network I/O unless it needs the
 * (optional, best-effort) `?page=all` merge — see `resolveFullArticleHtml()`.
 */

const SOURCE_ID = 'okezone';
const BASE_URL = 'https://www.okezone.com/';
const DISCOVERY_HOST = 'index.okezone.com';

// Explicit allowlist of live-verified okezone.com news-kanal hosts. See module header
// "allowed_domains is an explicit allowlist" for why this must never become `*.okezone.com`.
// Keys mirror the channelId values observed on `index.okezone.com`'s own "INDEKS KANAL"
// sidebar (verified live 2026-07-24) — kept as documentation/discovery metadata, not required
// for isArticleUrl() itself (host-membership alone is sufficient there).
const CHANNEL_ID_TO_KANAL_HOST = {
  1: 'news.okezone.com',
  11: 'economy.okezone.com',
  12: 'women.okezone.com',
  13: 'celebrity.okezone.com',
  2: 'sports.okezone.com',
  14: 'bola.okezone.com',
  630: 'ototekno.okezone.com',
  613: 'muslim.okezone.com',
  623: 'edukasi.okezone.com',
};

const ALLOWED_ARTICLE_HOSTS = new Set(Object.values(CHANNEL_ID_TO_KANAL_HOST));

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'okezone');
const FIXTURE_KANAL_INDEKS_PATH = path.join(FIXTURES_DIR, 'kanal-indeks-news.html');
const FIXTURE_BYDATE_CHANNEL_PATH = path.join(FIXTURES_DIR, 'bydate-channel-bola.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');
const FIXTURE_ARTICLE_PAGE_ALL_PATH = path.join(FIXTURES_DIR, 'sample-article-page-all.html');
const FIXTURE_ARTICLE_BOLA_PATH = path.join(FIXTURES_DIR, 'sample-article-bola.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8;
const DEFAULT_KANAL = 'news';
const DEFAULT_CHANNEL_ID = 14; // bola — paired with the default kanal indeks channel (news) so
// the default discover() output spans >=2 kanal subdomains out of the box.
const MAX_MERGED_PAGES_SAFETY = 20; // documentation only: page-all is a single fetch either way.

// Article URLs: https://{kanal}.okezone.com/read/{YYYY}/{MM}/{DD}/{sectionId}/{articleId}/{slug}
// Host is pinned to ALLOWED_ARTICLE_HOSTS on purpose (see module header). `{sectionId}` and
// `{articleId}` are both digit runs; `{slug}` is kept permissive (kebab-case, verified live to
// occasionally include a stray trailing `-nbsp` from an HTML-entity artifact upstream).
const ARTICLE_PATH_PATTERN = /^\/read\/(\d{4})\/(\d{2})\/(\d{2})\/(\d+)\/(\d+)\/[a-z0-9-]+\/?$/i;

// robots.txt (verified live on every sampled kanal host) disallows `/more/*` and `/mmore/*`;
// `/indeks`, `/tag/`, `/search`, `/author/`, `/foto`, `/video`, `/infografis` are listing/
// utility/gallery pages this adapter doesn't parse as articles either way.
const NON_ARTICLE_PATH_PATTERN = /^\/(more|mmore|indeks|tag|author|search|foto|video|infografis)(\/|$)/i;

// Indonesian full month names (lowercase), as seen live in both discovery listing timestamps
// ("24 Juli 2026 15:18:24", "Jum'at, 24 Juli 2026 15:18 WIB") and used as a fallback date
// parser wherever a no-timezone or human-readable Indonesian date string needs converting.
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

function isLiveCrawlEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
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
    displayName: 'Okezone',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 20,
    overlapHours: 3,
    enabled: true,
  };
}

/**
 * @param {string} url
 * @returns {boolean} true iff `url`'s hostname is one of the explicit `ALLOWED_ARTICLE_HOSTS`
 *   (case-insensitive) — deliberately NOT a `*.okezone.com` wildcard, see module header.
 */
function isInScope(url) {
  try {
    return ALLOWED_ARTICLE_HOSTS.has(new URL(url).hostname.toLowerCase());
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
  if (NON_ARTICLE_PATH_PATTERN.test(parsed.pathname)) {
    return false;
  }
  return ARTICLE_PATH_PATTERN.test(parsed.pathname);
}

/**
 * @param {string} url
 * @returns {string|undefined} the `{articleId}` path segment (2nd-to-last), stable across
 *   kanal/subdomain (verified live to match the article's own JSON-LD
 *   `mainEntityOfPage["@id"]`). Present whenever `url`'s path has the `/read/.../{id}/{slug}`
 *   shape, regardless of whether the host itself is in `ALLOWED_ARTICLE_HOSTS` (so a caller can
 *   still recover an id from an out-of-scope-but-similarly-shaped URL if ever needed).
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const match = ARTICLE_PATH_PATTERN.exec(new URL(url).pathname);
    return match ? match[5] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the `{sectionId}` path segment (3rd-to-last) — a low-confidence
 *   discovery-time category hint (real `category` should come from the parsed breadcrumb).
 */
function extractSectionId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const match = ARTICLE_PATH_PATTERN.exec(new URL(url).pathname);
    return match ? match[4] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Strips the `page` query param (`?page=2`, `?page=all`) so multipage article URLs collapse to
 * one canonical identity, mirroring every other adapter in this repo (detik/liputan6/tempo/
 * viva's `stripPageParam`).
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

function buildPageAllUrl(canonicalUrl) {
  try {
    const parsed = new URL(canonicalUrl);
    parsed.searchParams.set('page', 'all');
    return parsed.toString();
  } catch (_err) {
    return `${canonicalUrl}${canonicalUrl.includes('?') ? '&' : '?'}page=all`;
  }
}

/**
 * @param {{kanal?: string, date?: {y: string|number, m: string|number, d: string|number}, offset?: number}} [opts]
 * @returns {string} `https://{kanal}.okezone.com/indeks[/{Y}/{M}/{D}[/{offset}]]` — offset is
 *   only ever appended alongside a date (matches the live pagination shape,
 *   `/indeks/{Y}/{M}/{D}/{offset}`, offset increments of 10 per page — see module header).
 */
function buildKanalIndeksUrl({ kanal = DEFAULT_KANAL, date, offset } = {}) {
  let url = `https://${kanal}.okezone.com/indeks`;
  if (date) {
    const y = String(date.y);
    const m = String(date.m).padStart(2, '0');
    const d = String(date.d).padStart(2, '0');
    url += `/${y}/${m}/${d}`;
    if (Number.isInteger(offset) && offset > 0) {
      url += `/${offset}`;
    }
  }
  return url;
}

/**
 * @param {{channelId?: number|string, date?: {y: string|number, m: string|number, d: string|number}, offset?: number}} [opts]
 * @returns {string} `https://index.okezone.com/bydate/channel/{Y}/{M}/{D}/{channelId}[/{offset}/]`
 *   — offset increments of 15 per page (see module header).
 */
function buildBydateChannelUrl({ channelId = DEFAULT_CHANNEL_ID, date } = {}, offset) {
  const now = new Date();
  const y = date ? String(date.y) : String(now.getUTCFullYear());
  const m = date ? String(date.m).padStart(2, '0') : String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = date ? String(date.d).padStart(2, '0') : String(now.getUTCDate()).padStart(2, '0');
  let url = `https://${DISCOVERY_HOST}/bydate/channel/${y}/${m}/${d}/${channelId}`;
  if (Number.isInteger(offset) && offset > 0) {
    url += `/${offset}/`;
  }
  return url;
}

/**
 * @param {string} text - e.g. "24 Juli 2026 15:18:24" or "Jum'at, 24 Juli 2026 15:18 WIB" or a
 *   no-timezone JSON-LD `dateModified` value re-shaped to "24 Juli 2026 15:16:40"-style text.
 *   Both listing timestamp shapes verified live (see module header); seconds and the leading
 *   weekday/trailing "WIB" are all optional.
 * @returns {string|undefined} ISO 8601 string, assuming `+07:00` (WIB) for the no-tz input.
 */
function parseIndonesianDateTime(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute, second] = match;
  const monthIndex = MONTH_INDEX_ID[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:${second || '00'}+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {string} text - JSON-LD `dateModified` value verified live to carry NO timezone
 *   marker, e.g. "2026-07-24 15:16:40" (unlike `datePublished`, which does carry `+07:00`).
 * @returns {string|undefined} ISO 8601 string, assuming `+07:00` (WIB).
 */
function parseNoTzWibDateTime(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const normalized = hasTz ? text : `${text.trim().replace(' ', 'T')}+07:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Extracts up to `limit` unique in-scope article entries (in document order) from a single
 * kanal's own `/indeks` listing page (`.group-brt-terkini .subgroup`, verified live on
 * `news.okezone.com/indeks`). Shared by both the fixture and live discovery paths.
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function parseKanalIndeksHtml(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('.subgroup').each((_, el) => {
    if (items.length >= limit) return;
    const $el = $(el);
    const href = $el.find('a.desc-text[href]').first().attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    items.push({
      rawUrl: href,
      listingTitle: $el.find('a.desc-text').first().text().trim() || undefined,
      publishedHint: parseIndonesianDateTime($el.find('a.time-text').first().text().trim()),
      categoryHint: $el.find('a.title-text').first().text().trim() || undefined,
      externalId: extractExternalId(href),
    });
  });

  return items.slice(0, limit);
}

/**
 * Extracts up to `limit` unique in-scope article entries (in document order) from
 * `index.okezone.com`'s cross-channel `bydate` listing (`<time class="category-hardnews">
 * {category} | {date}</time><h4 class="f17"><a>{title}</a></h4>`, verified live). Shared by
 * both the fixture and live discovery paths.
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, categoryHint?: string, externalId?: string}>}
 */
function parseBydateChannelHtml(html, limit) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('h4.f17 a[href]').each((_, el) => {
    if (items.length >= limit) return;
    const $link = $(el);
    const href = $link.attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    const $time = $link.closest('.content-hardnews').find('time.category-hardnews').first();
    const timeText = $time.text();
    const [categoryPart, datePart] = timeText.split('|');

    items.push({
      rawUrl: href,
      listingTitle: $link.text().trim() || undefined,
      publishedHint: parseIndonesianDateTime((datePart || '').trim()),
      categoryHint: (categoryPart || '').trim() || undefined,
      externalId: extractExternalId(href),
    });
  });

  return items.slice(0, limit);
}

/**
 * Fetches one discovery listing page over HTTP, returning `undefined` on any non-2xx/network
 * failure (never throws) so callers can fall back to the bundled fixture.
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
 * Discovers candidate article URLs from BOTH live-verified channels (see module header):
 * a single kanal's own `/indeks` (default `news`) AND `index.okezone.com`'s cross-channel
 * `bydate` listing (default channelId 14 = bola) — combined so the default output already
 * spans >=2 kanal subdomains, proving the multi-subdomain scope the task brief asks for.
 * Each channel independently falls back to its own bundled fixture on a live failure/empty
 * result (same graceful-degrade pattern as `detik/index.js`/`liputan6/index.js`).
 *
 * @param {{limit?: number, kanal?: string, channelId?: number|string, date?: Object,
 *   logger?: {warn?: Function}, liveDiscover?: boolean}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discover(ctx = {}) {
  const limit = Number.isInteger(ctx.limit) && ctx.limit > 0 ? ctx.limit : DEFAULT_DISCOVER_LIMIT;
  const perChannelLimit = Math.max(1, Math.ceil(limit / 2));
  const logger = ctx.logger || console;
  const live = isLiveCrawlEnabled(ctx);

  const kanal = ctx.kanal || DEFAULT_KANAL;
  const channelId = ctx.channelId || DEFAULT_CHANNEL_ID;

  let kanalHtml;
  let kanalChannelTag = `kanal_indeks:${kanal}`;
  if (live) {
    kanalHtml = await fetchLivePage(buildKanalIndeksUrl({ kanal, date: ctx.date }));
    if (!kanalHtml && typeof logger.warn === 'function') {
      logger.warn(`[okezone] discover(): live kanal indeks fetch failed for "${kanal}"; falling back to fixture`);
    }
  }
  if (!kanalHtml) {
    kanalHtml = readFixture(FIXTURE_KANAL_INDEKS_PATH);
    kanalChannelTag = live ? `${kanalChannelTag}:fixture_fallback` : `${kanalChannelTag}:fixture`;
  }
  const kanalItems = parseKanalIndeksHtml(kanalHtml, perChannelLimit).map((item) => ({
    ...item,
    discoveryChannel: kanalChannelTag,
  }));

  let bydateHtml;
  let bydateChannelTag = `bydate_channel:${channelId}`;
  if (live) {
    bydateHtml = await fetchLivePage(buildBydateChannelUrl({ channelId, date: ctx.date }));
    if (!bydateHtml && typeof logger.warn === 'function') {
      logger.warn(`[okezone] discover(): live bydate channel fetch failed for channelId "${channelId}"; falling back to fixture`);
    }
  }
  if (!bydateHtml) {
    bydateHtml = readFixture(FIXTURE_BYDATE_CHANNEL_PATH);
    bydateChannelTag = live ? `${bydateChannelTag}:fixture_fallback` : `${bydateChannelTag}:fixture`;
  }
  const bydateItems = parseBydateChannelHtml(bydateHtml, perChannelLimit).map((item) => ({
    ...item,
    discoveryChannel: bydateChannelTag,
  }));

  const merged = [];
  const seen = new Set();
  for (const item of [...kanalItems, ...bydateItems]) {
    if (seen.has(item.rawUrl)) continue;
    seen.add(item.rawUrl);
    merged.push({
      rawUrl: item.rawUrl,
      normalizedUrl: stripPageParam(item.rawUrl),
      discoveryChannel: item.discoveryChannel,
      listingTitle: item.listingTitle,
      publishedHint: item.publishedHint,
      categoryHint: item.categoryHint,
      externalId: item.externalId,
    });
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

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  if (!hasTz && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return parseNoTzWibDateTime(value);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {Object|undefined} breadcrumbLd - `BreadcrumbList` JSON-LD block (verified live to
 *   carry the correctly-cased category name, e.g. "Nasional" — the DOM breadcrumb itself is
 *   all-caps, "NASIONAL").
 * @returns {string|undefined} the most specific (last) non-"Home" item name.
 */
function extractCategoryFromBreadcrumb(breadcrumbLd) {
  const items = breadcrumbLd && Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  const names = items
    .map((entry) => entry && entry.item && entry.item.name)
    .filter((name) => typeof name === 'string' && name.length > 0 && name.toLowerCase() !== 'home');
  return names.length > 0 ? names[names.length - 1] : undefined;
}

/**
 * Detects how many pages a page-1 article response spans, via the `#paging .box-nomor a.nomor`
 * widget (verified live — one `<a>` per page; absent entirely on both single-page articles and
 * on an already-merged `?page=all` response).
 * @param {cheerio.CheerioAPI} $
 * @returns {number}
 */
function detectTotalPages($) {
  const count = $('#paging .box-nomor a.nomor').length;
  return count > 0 ? count : 1;
}

/**
 * Resolves the FULL article HTML (every page merged), preferring a single `?page=all` fetch
 * over per-page `?page=N` fetches (per task brief). Resolution order for how to obtain the
 * `?page=all` response, mirroring `viva/index.js`'s multipage helper:
 *   1. `ctx.fetchPage(pageAllUrl, 'all')` — injected by tests/callers (offline-safe).
 *   2. The bundled `?page=all` fixture, IF `firstPageHtml` itself came from the bundled
 *      single-page-1 fixture (keeps offline smoke testing deterministic).
 *   3. Live HTTP via axios, IF `CRAWL_LIVE=true` (or `ctx.liveDiscover === true`).
 *   4. Otherwise: give up gracefully and return `firstPageHtml` alone (best-effort, matches how
 *      `parse()` already degrades gracefully elsewhere in this codebase).
 * @param {string} firstPageHtml
 * @param {string|undefined} canonicalUrl
 * @param {Object} [ctx]
 * @returns {Promise<{html: string, pagesDetected: number, mergedViaPageAll: boolean}>}
 */
async function resolveFullArticleHtml(firstPageHtml, canonicalUrl, ctx) {
  const $ = cheerio.load(firstPageHtml);
  const pagesDetected = detectTotalPages($);

  if (pagesDetected <= 1 || !canonicalUrl) {
    return { html: firstPageHtml, pagesDetected, mergedViaPageAll: false };
  }

  const pageAllUrl = buildPageAllUrl(canonicalUrl);
  const isFixtureFirstPage = firstPageHtml === readFixtureSafe(FIXTURE_ARTICLE_PATH);

  try {
    if (ctx && typeof ctx.fetchPage === 'function') {
      const pageAllHtml = await ctx.fetchPage(pageAllUrl, 'all');
      if (pageAllHtml) return { html: pageAllHtml, pagesDetected, mergedViaPageAll: true };
    } else if (isFixtureFirstPage) {
      const pageAllHtml = readFixtureSafe(FIXTURE_ARTICLE_PAGE_ALL_PATH);
      if (pageAllHtml) return { html: pageAllHtml, pagesDetected, mergedViaPageAll: true };
    } else if (isLiveCrawlEnabled(ctx)) {
      const pageAllHtml = await fetchLivePage(pageAllUrl);
      if (pageAllHtml) return { html: pageAllHtml, pagesDetected, mergedViaPageAll: true };
    }
  } catch (_err) {
    // fall through to the page-1-only result below.
  }

  return { html: firstPageHtml, pagesDetected, mergedViaPageAll: false };
}

// Elements stripped from `.c-detail.read` before pulling `<p>` text: "Baca Juga" recirculation
// blocks, embedded video iframe wrappers, inline scripts/styles, and the `?page=all`
// page-break marker divs between merged pages (all verified live).
const BODY_NOISE_SELECTORS = ['#baca-juga', '.vicon', 'script', 'style', 'div[style*="page-break"]'];

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractParagraphs($) {
  const $content = $('.c-detail.read').first().clone();
  $content.find(BODY_NOISE_SELECTORS.join(', ')).remove();

  return $content
    .find('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

/**
 * @param {string} html - page-1 HTML (fetched or fixture).
 * @param {Object} [ctx]
 * @returns {Promise<Object>} raw ParsedArticle-like draft (camelCase); see coreAdapter.js for
 *   the mapping to the core snake_case shape + the field-provenance matrix.
 */
async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const firstPageHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $first = cheerio.load(firstPageHtml);
  const ldBlocksFirst = extractJsonLdBlocks($first);
  const articleLdFirst = findByType(ldBlocksFirst, 'NewsArticle') || {};
  const webPageLdFirst = findByType(ldBlocksFirst, 'WebPage');
  const breadcrumbLdFirst = findByType(ldBlocksFirst, 'BreadcrumbList');

  const canonicalUrlRaw =
    (ctx && ctx.url) ||
    $first('link[rel="canonical"]').attr('href') ||
    $first('meta[property="og:url"]').attr('content') ||
    (webPageLdFirst && webPageLdFirst.url) ||
    undefined;
  const canonicalUrl = canonicalUrlRaw ? stripPageParam(canonicalUrlRaw) : undefined;

  const { html: fullHtml, pagesDetected, mergedViaPageAll } = await resolveFullArticleHtml(
    firstPageHtml,
    canonicalUrl,
    ctx
  );

  const $ = fullHtml === firstPageHtml ? $first : cheerio.load(fullHtml);
  const ldBlocks = fullHtml === firstPageHtml ? ldBlocksFirst : extractJsonLdBlocks($);
  const articleLd = fullHtml === firstPageHtml ? articleLdFirst : findByType(ldBlocks, 'NewsArticle') || {};
  const breadcrumbLd = fullHtml === firstPageHtml ? breadcrumbLdFirst : findByType(ldBlocks, 'BreadcrumbList');

  const title =
    articleLd.headline ||
    $('.title-article h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const ldAuthor = articleLd.author;
  const author =
    (ldAuthor && typeof ldAuthor.name === 'string' && ldAuthor.name.trim()) ||
    $('.journalist a[href*="redaksi.okezone.com"]').first().text().trim() ||
    undefined;

  const publishedAt =
    toIsoOrUndefined(articleLd.datePublished) ||
    toIsoOrUndefined($('meta[itemprop="datePublished"]').attr('content'));
  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const summary =
    articleLd.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const ldImage = articleLd.image;
  const thumbnailUrl =
    (ldImage && (typeof ldImage === 'string' ? ldImage : ldImage.url)) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const category = extractCategoryFromBreadcrumb(breadcrumbLd);

  const tags = $('#tag .box-tag a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);

  const externalArticleId = extractExternalId(canonicalUrl || (ctx && ctx.url) || '');
  const sectionId = extractSectionId(canonicalUrl || (ctx && ctx.url) || '');

  const paragraphs = extractParagraphs($);

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
    externalArticleId,
    sectionId,
    paragraphs,
    pagesDetected,
    mergedViaPageAll,
    rawHtml: firstPageHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/okezone/smoke-test.js) and for
  // debugging extraction logic in isolation.
  isInScope,
  extractExternalId,
  extractSectionId,
  stripPageParam,
  buildPageAllUrl,
  buildKanalIndeksUrl,
  buildBydateChannelUrl,
  parseKanalIndeksHtml,
  parseBydateChannelHtml,
  parseIndonesianDateTime,
  parseNoTzWibDateTime,
  extractJsonLdBlocks,
  findByType,
  extractCategoryFromBreadcrumb,
  detectTotalPages,
  resolveFullArticleHtml,
  extractParagraphs,
  isLiveCrawlEnabled,
  ALLOWED_ARTICLE_HOSTS,
  CHANNEL_ID_TO_KANAL_HOST,
  DISCOVERY_HOST,
  FIXTURE_KANAL_INDEKS_PATH,
  FIXTURE_BYDATE_CHANNEL_PATH,
  FIXTURE_ARTICLE_PATH,
  FIXTURE_ARTICLE_PAGE_ALL_PATH,
  FIXTURE_ARTICLE_BOLA_PATH,
};
