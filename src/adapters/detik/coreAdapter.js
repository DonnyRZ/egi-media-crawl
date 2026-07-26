'use strict';

const rawDetik = require('./index');
const { parseListingDateIso } = require('../../core/parseListingDate');

/**
 * Contract-adapter layer for the Detik live adapter (F5) -> crawler core (F3) + db layer (F6).
 *
 * `./index.js` (F5) implements the `src/adapters/_template` contract, which uses
 * camelCase field names (`sourceId`, `rawUrl`, `discoveryChannel`, `publishedAt`, ...).
 * `src/core` (F3) — `runPipeline` + the `ParsedArticle`/`SourceProfile`/`DiscoveryItem`
 * typedefs in `src/core/types.js` — expects snake_case fields (`source_id`,
 * `adapter_version`, `content_text`, `channel`, `published_hint`, ...) and expects
 * `discover()` to resolve/return an array of items directly (not `{ items: [...] }`).
 *
 * Rather than rewriting core or the raw F5 stub, this module is the single place that
 * bridges the two shapes. `src/adapters/index.js` exposes THIS module for `sourceId
 * "detik"`, so every caller (workers, scripts/crawl-once.js, src/sources/registry.js)
 * gets an adapter that satisfies both:
 *   - `assertAdapterShape`/`runPipeline` (core, snake_case)
 *   - `src/sources/registry.js`'s `profile.sourceId` check (still camelCase)
 * via a `getSourceProfile()` that returns both key styles on one object.
 */

// Bumped independently from the raw adapter's internal version if its parsing logic
// changes; stored on every article row (articles.adapter_version / parser_version).
// "_v1_live" marks the switch from the network-free fixture-only stub to a live-capable
// discover()/parse() (still fixture-first when no HTML/network is available, see ./index.js).
const ADAPTER_VERSION = 'detik_v1_live';

/**
 * Listing `publishedHint` may be a human-readable Indonesian string (e.g. fixture
 * "Kamis, 23 Jul 2026 14:35 WIB") or absent on live indeks items. Parsed via shared
 * `parseListingDateIso` so `discovered_urls.published_hint` (TIMESTAMPTZ) and overlap-stop
 * agree. Live indeks still often omits a per-item hint — residual documented on raw discover.
 * @param {string|undefined} hint
 * @returns {string|undefined} ISO 8601 string, or undefined if unparseable/absent.
 */
function tryParseHint(hint) {
  return parseListingDateIso(hint);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url` (mirrors
 * `viva/index.js`'s `stripPageParam`, see Sprint 2 gap audit P1). Detik's own canonical tag
 * doesn't currently emit one, but this keeps the invariant defended rather than assumed.
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

/**
 * Minimal `field_provenance` (N5 contract) for the fields the gap audit flagged as missing
 * entirely on detik. Mirrors the richer suara/viva pattern lightly — a source/confidence map
 * rather than a full per-article-derived object, since detik's `./index.js` doesn't track
 * per-field fallback usage the way suara's `multipage` object does.
 * @returns {Object}
 */
function buildFieldProvenance() {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|json_ld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'json_ld:headline|dom:.detail__title|og:title', confidence: 'high' },
    content_text: { source: 'dom:.detail__body-text|.itp_bodycontent', confidence: 'high' },
    published_at: { source: 'json_ld:datePublished|dom:.detail__date time[datetime]', confidence: 'high' },
  };
}

/**
 * @param {import('./index').DiscoveredItem} item - raw F5 shape.
 * @returns {import('../../core/types').DiscoveryItem} core shape.
 */
function toCoreDiscoveryItem(item) {
  return {
    url: item.rawUrl,
    channel: item.discoveryChannel || 'unknown',
    title_hint: item.listingTitle,
    published_hint: tryParseHint(item.publishedHint),
    metadata: item.normalizedUrl ? { normalizedUrlHint: item.normalizedUrl } : undefined,
  };
}

/**
 * @param {ReturnType<typeof rawDetik.parse>} draft - raw F5 ParsedArticle-like shape
 *   (`sourceId`, `url`, `title`, `author`, `publishedAt`, `updatedAt`, `summary`,
 *   `thumbnailUrl`, `category`, `tags`, `externalArticleId`, `paragraphs`, `rawHtml`).
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    canonical_url: draft.url ? stripPageParam(draft.url) : undefined,
    external_article_id: draft.externalArticleId || undefined,
    title: draft.title,
    content_text: contentText,
    content_html: contentHtml,
    // N5 contract optional fields: only populated once the raw draft actually extracts them
    // (JSON-LD description / og:image / URL-derived category / detail__body-tag), so this
    // stays a no-op for any future raw parse() that omits one. `language` is hardcoded since
    // Detik is Indonesian-only.
    summary: draft.summary || undefined,
    thumbnail_url: draft.thumbnailUrl || undefined,
    category: draft.category || undefined,
    tags: Array.isArray(draft.tags) && draft.tags.length > 0 ? draft.tags : undefined,
    author_name: draft.author,
    published_at: draft.publishedAt,
    updated_at_source: draft.updatedAt,
    language: 'id',
    parser_version: ADAPTER_VERSION,
    field_provenance: buildFieldProvenance(),
  };
}

/**
 * @returns {import('../../core/types').SourceProfile & {sourceId: string, displayName: string, baseUrl: string, crawlIntervalMinutes: number, overlapHours: number}}
 */
function getSourceProfile() {
  const raw = rawDetik.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    timezone: raw.timezone,
    crawl_interval_minutes: raw.crawlIntervalMinutes,
    overlap_hours: raw.overlapHours,
    enabled: raw.enabled,
    normalizeUrlOptions: {},

    // camelCase aliases: src/sources/registry.js still reads `profile.sourceId` etc.
    sourceId: raw.sourceId,
    displayName: raw.displayName,
    baseUrl: raw.baseUrl,
    crawlIntervalMinutes: raw.crawlIntervalMinutes,
    overlapHours: raw.overlapHours,
  };
}

function isArticleUrl(url, ctx) {
  return rawDetik.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawDetik.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawDetik.parse(html, ctx);
  return toParsedArticle(draft);
}

module.exports = {
  ADAPTER_VERSION,
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / debugging the mapping in isolation.
  toCoreDiscoveryItem,
  toParsedArticle,
  stripPageParam,
  buildFieldProvenance,
};
