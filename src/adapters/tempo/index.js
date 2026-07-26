'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Tempo.co (www.tempo.co) adapter — Sprint 4 (S4-A). camelCase raw adapter, following the
 * same fixture-first pattern as `src/adapters/tirto/index.js` / `src/adapters/cnn_indonesia/
 * index.js` / `src/adapters/liputan6/index.js` / `src/adapters/kumparan/index.js`.
 * `src/adapters/tempo/coreAdapter.js` bridges this to the snake_case `ParsedArticle` shape
 * `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct `curl` fetches,
 * with a plain desktop-browser `User-Agent`, of https://www.tempo.co/ and several real
 * rubrik/article pages — Cloudflare let every one of these through with HTTP 200; no
 * challenge page was ever observed with that UA):
 *
 *  - crawlable / go-with-limits. Scope restricted to `tempo.co` and `www.tempo.co` only (per
 *    the task brief's host-pin instruction) — both are legitimately used across the site's
 *    OWN markup (canonical/`og:url`/`mainEntityOfPage` all use `www.tempo.co`; the site's own
 *    `BreadcrumbList` JSON-LD items use the bare `tempo.co`), so both are accepted in
 *    `isArticleUrl()`.
 *  - **Discovery is NOT HTML-scrapable, exactly as the task brief warned**: verified live that
 *    both `https://www.tempo.co/` and any `https://www.tempo.co/{rubrik}` category page are a
 *    Nuxt (Vue) app whose INITIAL SSR response contains only `window.__NUXT__={}` (an empty
 *    stub) — zero article `<a href>`s anywhere in the raw HTML. The real listing data is a
 *    separate Nuxt "payload" JSON document, fetched by the client (and independently
 *    fetchable directly) at `https://www.tempo.co/{rubrik}/_payload.json` (verified live on
 *    `ekonomi` and `politik`; e.g. `/nasional/_payload.json` 404s because `nasional` is not a
 *    real Tempo rubrik alias — the live, verified top-level rubrik aliases, from the site's own
 *    `menu-navbar` payload entry, are: `politik`, `hukum`, `ekonomi`, `lingkungan`,
 *    `wawancara`, `investigasi`, `cekfakta`, `tokoh` — `play`/`newsletter`/`info-tempo` are also
 *    real top-level paths but are not news rubrics and are excluded from `KNOWN_RUBRICS`).
 *    `_payload.json` is Nuxt's own "devalue"-style payload format: a single top-level JSON
 *    array where element 0 is the root pointer and every other element is either a literal
 *    (string/number/bool/null) OR a container (plain object / array) whose OWN values are
 *    themselves non-negative-integer INDICES into the same array (i.e. "pointers", resolved by
 *    recursively looking up `arr[i]`) — negative numbers (e.g. a real live `"prerenderedAt":
 *    -1`) are never valid indices and are always literals. `decodeNuxtPayload()` /
 *    `materializeNuxtValue()` below implement a minimal, defensive decoder for exactly this
 *    shape (no `ShallowRef`/`Set`/`Map`/`Date`/etc-tagged-array special cases beyond the single
 *    `["ShallowReactive", idx]` wrapper actually observed live wrapping the root key map — any
 *    OTHER tagged-array shape is simply decoded as a plain array, which is safe/inert since
 *    this adapter never reads one). Once decoded, the root's `.data['rubric-content'].latest
 *    .data` key (verified live, STABLE across both `ekonomi` and `politik` samples) is an array
 *    of article summary objects carrying `id`, `article_uuid`, `access` ("FREE"/"VIP"/
 *    "FREEMIUM" — verified live all three appear in a single real rubrik listing),
 *    `content_category`, `title_digital`, `description`, `canonical_url` (relative, e.g.
 *    `"ekonomi/{slug}-{id}"` — NO leading slash, NO domain), `published_at` (`"YYYY-MM-DD
 *    HH:MM:SS"`, no timezone marker), `feature_image`. This is the sole discovery channel this
 *    adapter implements — there is no HTML fallback to fall back to (per the task brief, `/
 *    {rubrik}` alone is empty of article links; no separate `/indeks` route was found live
 *    either, unlike detik/tirto).
 *  - Article URL shape: `https://www.tempo.co/{rubrik}/{slug-words}-{numericId}`, e.g.
 *      https://www.tempo.co/ekonomi/trump-umumkan-tarif-impor-baru-ke-60-negara-2277913
 *    `{numericId}` (verified live, always digits-only, 7 digits in every live sample but not
 *    assumed fixed-length here) is Tempo's own internal article id and is reused as
 *    `external_article_id`. The exactly-2-path-segment + trailing-`-{digits}` shape is what
 *    actually discriminates real articles from rubrik-root pages (1 segment, e.g. `/ekonomi`)
 *    and sub-rubrik listing pages (2 segments but the 2nd never ends in digits live, e.g.
 *    `/ekonomi/bisnis`, `/ekonomi/sinyal-pasar`, `/politik/pendidikan`) with NO extra
 *    allow/deny list needed for either of those — the one real live collision risk is author
 *    profile pages, `/penulis/{name}-{id}` (verified live, e.g. `/penulis/aditya-budiman-998`),
 *    which DO end in `-{digits}` and would otherwise false-positive; `RESERVED_FIRST_SEGMENTS`
 *    excludes `penulis` (and `tag`, since `/tag/{alias}` is also syntactically 2 segments and
 *    some tag aliases are live-observed to end in digits too, e.g. a hypothetical
 *    "piala-dunia-2026") explicitly for this reason.
 *  - Article page carries a `NewsArticle` JSON-LD block that is UNUSUALLY complete for this
 *    codebase (verified live; every other adapter here — detik/CNN Indonesia/Liputan6/Tirto/
 *    Kumparan/Suara/VIVA — has metadata-only JSON-LD with no `articleBody`): `headline`,
 *    `description`, `image` (bare string, not an array), `datePublished` (full ISO 8601 WITH an
 *    explicit `+07:00` offset already — no "assume WIB" guessing needed here, same as
 *    Kumparan), `isAccessibleForFree` (boolean — verified live `true` on free articles and
 *    `false` on Tempo Plus/"VIP" ones, where `articleBody` is ALSO independently verified live
 *    to be truncated to just a short teaser paragraph — both signals agree), `articleBody`
 *    itself (`\n`-joined plain-text paragraphs, HTML-entity-encoded, with a trailing "Pilihan
 *    Editor: <related article title>" line that is NOT real body content — see below),
 *    `author` (an ARRAY of `Person`, verified live sometimes containing the exact same
 *    person listed twice, e.g. once as reporter once as editor — deduplicated by name in
 *    `extractAuthorNames()`), `publisher`, `mainEntityOfPage`. NO `dateModified` was observed
 *    live on any sampled article (free or Tempo Plus) — `updated_at_source` has no known source
 *    for Tempo today and is always left `undefined`.
 *  - A separate `BreadcrumbList` JSON-LD block (verified live) carries `[Home, {rubrik}, {sub-
 *    rubrik}]` (e.g. `[Home, Ekonomi, Bisnis]`) — `category` uses the last (most specific) item.
 *  - Despite the rich JSON-LD, the article body is ALSO independently server-rendered into the
 *    DOM (verified live — NOT a client-side-only SPA render for the body, unlike the rubrik
 *    listing): each real paragraph sits inside its OWN `<div id="content-wrapper">` wrapper
 *    (verified live, one such div per paragraph, interleaved with ad-slot `<div>`s and a
 *    "Scroll ke bawah untuk melanjutkan membaca" lazy-load-gate paragraph that live OUTSIDE any
 *    `#content-wrapper`, so a scoped `#content-wrapper p, #content-wrapper h2, #content-wrapper
 *    h3` selector naturally excludes both kinds of noise with no extra stripping needed for
 *    them). This DOM path is the PRIMARY body source (preserves inline `<a>` tag-links/`<em>`
 *    formatting that the flattened JSON-LD `articleBody` string does not); `articleBody` itself
 *    is kept only as a fallback for a future template change. The one noise pattern that DOES
 *    live inside `#content-wrapper` on every sampled article — a trailing "Pilihan Editor:
 *    <link>" paragraph (a related-article pick, not real body content, verified live present in
 *    BOTH the DOM and the JSON-LD `articleBody` in every sample) — is filtered out by
 *    `extractParagraphs()` via a `/^Pilihan Editor\s*:/i` match, same noise-stripping spirit as
 *    Tirto's "Baca juga" / CNN Indonesia's "Lihat Juga".
 *  - `tags` <- the tag-pill widget near the end of the article, DOM `a[href^="/tag/"]`
 *    (relative-href only; verified live this excludes the 1-2 INLINE contextual `/tag/` links
 *    that sometimes sit inside `#content-wrapper` paragraphs themselves, which use absolute
 *    `https://www.tempo.co/tag/...` hrefs instead — the relative-href widget list matches
 *    Tempo's own internal `tag_article_new` field exactly on every live sample checked). Anchor
 *    text IS the raw kebab-case alias (e.g. "tarif-impor", not "Tarif Impor") — that is what
 *    the live site itself displays, kept as-is rather than invented/humanized.
 *  - `author_name` <- JSON-LD `author[].name`, deduplicated. DOM fallback: `a[href*="/penulis/
 *    "]` with non-empty text (verified live one such link is an avatar-only `<a>` with empty
 *    text and a second carries the real name — both present, the empty one is filtered out).
 *  - No live multipage markup was found on any sampled live article (every article ships as a
 *    single document) — `parse()` still defensively strips any `?page=` query param before
 *    using a URL as `canonical_url`, mirroring every other adapter in this repo.
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every sibling adapter); otherwise it
 * reads the bundled `fixtures/tempo/rubric-payload.json` Nuxt-payload fixture and maps it
 * through the exact same `extractRubricLatestItems()`/`mapPayloadItemsToEntries()` a live
 * response would go through. `parse()` is fixture-first when no `html` is supplied (or
 * `ctx.fixtureOnly` is set), reading `fixtures/tempo/sample-article.html`.
 */

const SOURCE_ID = 'tempo';
const BASE_URL = 'https://www.tempo.co/';
const ALLOWED_HOSTS = new Set(['tempo.co', 'www.tempo.co']);

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'tempo');
const FIXTURE_PAYLOAD_PATH = path.join(FIXTURES_DIR, 'rubric-payload.json');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range
const DEFAULT_RUBRIC = 'ekonomi';

// Real, live-verified top-level rubrik aliases (from the site's own `menu-navbar` payload
// entry, fetched live 2026-07-24) that actually carry news content. `play`/`newsletter`/
// `info-tempo` are also real top-level paths on tempo.co but are not news rubrics, so they are
// deliberately excluded here (irrelevant to discovery, and `/play/_payload.json` was never
// fetched/verified).
const KNOWN_RUBRICS = [
  'ekonomi',
  'politik',
  'hukum',
  'lingkungan',
  'wawancara',
  'investigasi',
  'cekfakta',
  'tokoh',
];

// Article URLs are `/{rubrik}/{slug-words}-{numericId}` (exactly 2 path segments, 2nd segment
// ends in `-{one-or-more-digits}`). This alone excludes rubrik-root pages (1 segment) and every
// live-observed sub-rubrik listing page (2 segments, but none end in digits) — see module
// header "Article URL shape" note for why only `penulis`/`tag` need an explicit deny-list entry
// on top of this.
const ARTICLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/;

// `/penulis/{name}-{id}` and `/tag/{alias}` are the two live-verified 2-segment path shapes
// that could otherwise false-positive against ARTICLE_SLUG_PATTERN (see module header).
const RESERVED_FIRST_SEGMENTS = new Set(['penulis', 'tag']);

// Indonesian full month names, as seen live in `meta[property="article:published_time"]`
// ("24 Juli 2026 | 11.32 WIB" — note the "HH.MM" period-separated time, not "HH:MM", and the "
// | " separator between date and time; both verified live). Used only as a fallback: JSON-LD
// `datePublished` (full ISO 8601 with an explicit `+07:00` offset already) is the primary
// source and needs no such parsing.
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

// Related-article "pick" line verified live to trail both the DOM `#content-wrapper`
// paragraphs AND the JSON-LD `articleBody` on every sampled article — not real body content
// (see module header "Body text" note).
const EDITOR_PICK_PREFIX_PATTERN = /^pilihan editor\s*:/i;

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Tempo.co',
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
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return false;
  }
  const [firstSegment, secondSegment] = segments;
  if (RESERVED_FIRST_SEGMENTS.has(firstSegment.toLowerCase())) {
    return false;
  }
  return ARTICLE_SLUG_PATTERN.test(secondSegment);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url`. No live
 * multipage markup was found for Tempo (see module header) — this mirrors the invariant every
 * other adapter in this repo defends regardless.
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
 * @returns {string|undefined} the trailing numeric id (e.g. "2277913" from ".../2277913"),
 *   used as `external_article_id`.
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const { pathname } = new URL(url);
    const slug = pathname.split('/').filter(Boolean)[1] || '';
    const match = /-(\d+)$/.exec(slug);
    return match ? match[1] : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildRubricPayloadUrl(rubric) {
  return `${BASE_URL}${rubric}/_payload.json`;
}

/**
 * Minimal, defensive decoder for Nuxt's "devalue"-style `_payload.json` / `__NUXT_DATA__`
 * array format (see module header "Discovery" note for the full live-verified shape). Given
 * the raw top-level array, resolves index `idx` into a plain JS value, recursively resolving
 * every nested object/array property that is itself a valid (non-negative, in-bounds integer)
 * index. `["ShallowReactive", innerIdx]` is unwrapped transparently (the only tagged-array
 * shape actually observed live); any other array is decoded as a plain array. A `seen` map
 * guards against reference cycles (shared/self-referential indices are legal in this format).
 * @param {unknown[]} arr - the raw, `JSON.parse()`d top-level payload array.
 * @param {number} idx - index to resolve (0 is always the root pointer object).
 * @param {Map<number, unknown>} [seen] - internal cycle guard; do not pass explicitly.
 * @param {number} [depth] - internal recursion guard; do not pass explicitly.
 * @returns {unknown} the resolved plain value (string/number/boolean/null/plain object/array).
 */
function materializeNuxtValue(arr, idx, seen = new Map(), depth = 0) {
  if (depth > 40) return undefined;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= arr.length) {
    return idx;
  }
  if (seen.has(idx)) {
    return seen.get(idx);
  }
  const raw = arr[idx];
  if (raw === null || typeof raw !== 'object') {
    return raw;
  }
  if (Array.isArray(raw)) {
    if (raw.length === 2 && raw[0] === 'ShallowReactive') {
      const placeholder = {};
      seen.set(idx, placeholder);
      Object.assign(placeholder, materializeNuxtValue(arr, raw[1], seen, depth + 1));
      return placeholder;
    }
    const placeholder = [];
    seen.set(idx, placeholder);
    for (const v of raw) {
      placeholder.push(materializeNuxtValue(arr, v, seen, depth + 1));
    }
    return placeholder;
  }
  const placeholder = {};
  seen.set(idx, placeholder);
  for (const [key, v] of Object.entries(raw)) {
    placeholder[key] = materializeNuxtValue(arr, v, seen, depth + 1);
  }
  return placeholder;
}

/**
 * @param {unknown[]} payloadArr - raw, `JSON.parse()`d `_payload.json` array.
 * @returns {Object|undefined} the fully-resolved root object (`{data: {...}, prerenderedAt}`),
 *   or `undefined` if `payloadArr` isn't a non-empty array.
 */
function decodeNuxtPayload(payloadArr) {
  if (!Array.isArray(payloadArr) || payloadArr.length === 0) {
    return undefined;
  }
  return materializeNuxtValue(payloadArr, 0);
}

/**
 * Pulls the `rubric-content.latest.data` article-summary array out of a decoded rubrik
 * `_payload.json` root (see module header — this key was verified live STABLE across two
 * different rubrics, `ekonomi` and `politik`). Defensive: returns `[]` (never throws) if the
 * shape doesn't match, e.g. because Tempo's own internal payload schema changed.
 * @param {unknown[]} payloadArr - raw, `JSON.parse()`d `_payload.json` array.
 * @returns {Object[]}
 */
function extractRubricLatestItems(payloadArr) {
  try {
    const root = decodeNuxtPayload(payloadArr);
    const rubricContent = root && root.data && root.data['rubric-content'];
    const data = rubricContent && rubricContent.latest && rubricContent.latest.data;
    return Array.isArray(data) ? data : [];
  } catch (_err) {
    return [];
  }
}

/**
 * Maps decoded `rubric-content.latest.data` article-summary objects (live or fixture — same
 * shape either way) into raw discovery entries. Shared by `discoverLive()` and the offline
 * fixture path in `discover()` so both go through identical mapping logic.
 * @param {Object[]} rawItems
 * @param {{limit?: number, discoveryChannel?: string}} [opts]
 * @returns {Array<{rawUrl: string, normalizedUrl?: string, discoveryChannel: string, listingTitle?: string, publishedHint?: string, externalId?: string, categoryHint?: string, accessHint?: string}>}
 */
function mapPayloadItemsToEntries(rawItems, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_DISCOVER_LIMIT;
  const discoveryChannel = opts.discoveryChannel || 'rubric_payload';

  const items = [];
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    if (items.length >= limit) break;
    if (!item || typeof item.canonical_url !== 'string' || !item.canonical_url) continue;

    const rawUrl = `${BASE_URL}${item.canonical_url}`;
    if (!isArticleUrl(rawUrl)) continue;

    items.push({
      rawUrl,
      normalizedUrl: stripPageParam(rawUrl),
      discoveryChannel,
      listingTitle: item.title_digital || undefined,
      publishedHint: item.published_at || undefined,
      externalId: (item.id !== undefined && item.id !== null ? String(item.id) : undefined) || extractExternalId(rawUrl),
      categoryHint: item.content_category || undefined,
      accessHint: item.access || undefined,
    });
  }

  return items;
}

/**
 * @param {{limit?: number, rubric?: string, channelUrl?: string, logger?: Object}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  const limit = (ctx && ctx.limit) || DEFAULT_DISCOVER_LIMIT;
  const rubric = (ctx && ctx.rubric) || DEFAULT_RUBRIC;
  const payloadUrl = (ctx && ctx.channelUrl) || buildRubricPayloadUrl(rubric);

  const response = await axios.get(payloadUrl, {
    headers: { 'User-Agent': CRAWLER_UA, Accept: 'application/json' },
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'text',
  });

  if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
    return { items: [] };
  }

  let payloadArr;
  try {
    payloadArr = JSON.parse(response.data);
  } catch (_err) {
    return { items: [] };
  }

  const rawItems = extractRubricLatestItems(payloadArr);
  const items = mapPayloadItemsToEntries(rawItems, { limit, discoveryChannel: `rubric_payload:${rubric}` });
  return { items };
}

async function discover(ctx) {
  const limit = (ctx && ctx.limit) || DEFAULT_DISCOVER_LIMIT;

  if (isLiveDiscoverEnabled(ctx)) {
    try {
      const live = await discoverLive(ctx);
      if (live.items.length > 0) {
        return live;
      }
    } catch (err) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`tempo discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  const fixtureArr = JSON.parse(readFixture(FIXTURE_PAYLOAD_PATH));
  const rawItems = extractRubricLatestItems(fixtureArr);
  const items = mapPayloadItemsToEntries(rawItems, { limit, discoveryChannel: 'fixture' });
  return { items };
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
 * @param {Object|Object[]|undefined} author - JSON-LD `NewsArticle.author` (verified live to
 *   be an ARRAY of `Person`, sometimes with the exact same name repeated once per byline role
 *   — see module header). Deduplicated (case-insensitive) and joined with ", ".
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
 * DOM fallback for author: `a[href*="/penulis/"]` with non-empty text (verified live one such
 * link is an avatar-only `<a>` with empty text — see module header "author_name" note).
 * @param {cheerio.CheerioAPI} $
 * @returns {string|undefined}
 */
function extractAuthorFromDom($) {
  const names = [];
  const seen = new Set();
  $('a[href*="/penulis/"]').each((_, el) => {
    const name = $(el).text().trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  });
  return names.length > 0 ? names.join(', ') : undefined;
}

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {string} text - e.g. "24 Juli 2026 | 11.32 WIB" (verified live
 *   `meta[property="article:published_time"]` format — note the "HH.MM" period-separated
 *   time and the " | " date/time separator, both verified live and distinct from every other
 *   adapter's Indonesian-date fallback in this repo).
 * @returns {string|undefined} ISO 8601 string (assumes `WIB` => `+07:00`), used only when
 *   JSON-LD `datePublished` is absent (see module header — this is the fallback, not primary).
 */
function parseMetaPublishedTime(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*\|\s*(\d{1,2})[.:](\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX_ID[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {Object|undefined} breadcrumbLd
 * @returns {string[]} breadcrumb labels in order, e.g. ["Home", "Ekonomi", "Bisnis"] (verified
 *   live `BreadcrumbList` shape — see module header).
 */
function extractBreadcrumbLabels(breadcrumbLd) {
  const items = breadcrumbLd && Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  return items.map((entry) => entry && entry.name).filter((name) => typeof name === 'string' && name.length > 0);
}

/**
 * @param {string[]} breadcrumbLabels
 * @returns {string|undefined} the most specific (last) breadcrumb label, excluding "Home".
 */
function extractCategory(breadcrumbLabels) {
  const withoutHome = breadcrumbLabels.filter((label) => label.toLowerCase() !== 'home');
  return withoutHome.length > 0 ? withoutHome[withoutHome.length - 1] : undefined;
}

/**
 * Extracts the tag-pill widget list, DOM `a[href^="/tag/"]` (relative-href only — verified
 * live this excludes inline contextual `/tag/` links inside the body, which use absolute
 * hrefs instead; see module header "tags" note). Anchor text IS the raw kebab-case alias.
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractTags($) {
  const seen = new Set();
  const tags = [];
  $('a[href^="/tag/"]').each((_, el) => {
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
 * Extracts `#content-wrapper p, #content-wrapper h2, #content-wrapper h3` text, in document
 * order (verified live selector — see module header "Despite the rich JSON-LD" note on why no
 * extra ad/lazy-load-gate noise stripping is needed for THOSE; the one noise pattern that DOES
 * live inside this selector, a trailing "Pilihan Editor: ..." related-article pick, is
 * filtered out explicitly here).
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractParagraphsFromDom($) {
  return $('#content-wrapper p, #content-wrapper h2, #content-wrapper h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0 && !EDITOR_PICK_PREFIX_PATTERN.test(text));
}

/**
 * Fallback body source when `#content-wrapper` yields nothing (e.g. a future template change):
 * JSON-LD `articleBody` is `\n`-joined plain-text paragraphs (verified live) with the same
 * trailing "Pilihan Editor: ..." noise line filtered out.
 * @param {string|undefined} articleBody
 * @returns {string[]}
 */
function extractParagraphsFromArticleBody(articleBody) {
  if (typeof articleBody !== 'string' || !articleBody) return [];
  return articleBody
    .split('\n')
    .map((line) => line.trim())
    .filter((text) => text.length > 0 && !EDITOR_PICK_PREFIX_PATTERN.test(text));
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);
  const ldBlocks = extractJsonLdBlocks($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};
  const breadcrumbLd = findBreadcrumbLd(ldBlocks);

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && articleLd.mainEntityOfPage['@id']) ||
    undefined;

  const title =
    articleLd.headline ||
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author = extractAuthorNames(articleLd.author) || extractAuthorFromDom($);

  const publishedAt =
    toIsoOrUndefined(articleLd.datePublished) ||
    parseMetaPublishedTime($('meta[property="article:published_time"]').attr('content'));
  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const summary =
    articleLd.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const thumbnailUrl =
    (typeof articleLd.image === 'string' && articleLd.image) ||
    $('meta[property="og:image"]').attr('content') ||
    undefined;

  const isAccessibleForFree = typeof articleLd.isAccessibleForFree === 'boolean' ? articleLd.isAccessibleForFree : undefined;

  const breadcrumbLabels = extractBreadcrumbLabels(breadcrumbLd);
  const category = extractCategory(breadcrumbLabels);
  const tags = extractTags($);

  const externalArticleId = extractExternalId(url) || undefined;

  const domParagraphs = extractParagraphsFromDom($);
  const paragraphs = domParagraphs.length > 0 ? domParagraphs : extractParagraphsFromArticleBody(articleLd.articleBody);

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
    isAccessibleForFree,
    rawHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/tempo/smoke-test.js) and for
  // debugging extraction logic in isolation.
  isInScope,
  extractExternalId,
  buildRubricPayloadUrl,
  materializeNuxtValue,
  decodeNuxtPayload,
  extractRubricLatestItems,
  mapPayloadItemsToEntries,
  extractJsonLdBlocks,
  findNewsArticleLd,
  findBreadcrumbLd,
  extractAuthorNames,
  extractAuthorFromDom,
  extractBreadcrumbLabels,
  extractCategory,
  extractTags,
  extractParagraphsFromDom,
  extractParagraphsFromArticleBody,
  parseMetaPublishedTime,
  stripPageParam,
  discoverLive,
  isLiveDiscoverEnabled,
  KNOWN_RUBRICS,
  DEFAULT_RUBRIC,
  FIXTURE_PAYLOAD_PATH,
  FIXTURE_ARTICLE_PATH,
};
