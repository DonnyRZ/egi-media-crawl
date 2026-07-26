'use strict';

const rawSuara = require('./index');
const { parseListingDateIso } = require('../../core/parseListingDate');

/**
 * Contract-adapter layer for the Suara stub -> crawler core (F3) + db layer (F6).
 *
 * Same rationale as `src/adapters/detik/coreAdapter.js`: `./index.js` (raw stub) speaks the
 * `_template` contract's camelCase shape (`sourceId`, `rawUrl`, `discoveryChannel`,
 * `publishedAt`, `discover()` returning `{ items: [...] }`, ...), while `src/core`
 * (`runPipeline`) and the db layer expect snake_case (`source_id`, `adapter_version`,
 * `content_text`, `channel`, `published_hint`, ...) with `discover()` resolving an array
 * directly. This module is the single place that bridges the two shapes for `suara`, so
 * every caller (workers, scripts/crawl-once.js, src/sources/registry.js) sees one
 * core-compatible adapter via `src/adapters/index.js`.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump
// independently from the raw stub's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'suara_v1';

/**
 * Listing `publishedHint` is often a human-readable Indonesian string (e.g.
 * "Jum'at, 24 Juli 2026 | 07:08 WIB"). Parsed via shared `parseListingDateIso` so
 * `discovered_urls.published_hint` and overlap-stop agree. Time-only live fragments
 * (e.g. `"07:08"`) remain unparseable by design — see raw `discoverLive` residual.
 * @param {string|undefined} hint
 * @returns {string|undefined} ISO 8601 string, or undefined if unparseable/absent.
 */
function tryParseHint(hint) {
  return parseListingDateIso(hint);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url` (mirrors
 * `viva/index.js`'s `stripPageParam`, see Sprint 2 gap audit P1). Suara's multipage support
 * already merges pages 2..N under the page-1 URL, so this doesn't change behavior today —
 * it just defends the same invariant explicitly instead of relying on the source's canonical
 * tag never including a page param.
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
 * @param {import('./index').DiscoveredItem} item - raw stub shape.
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
 * @param {ReturnType<typeof rawSuara.parse>} draft - raw stub ParsedArticle-like shape
 *   (`sourceId`, `url`, `title`, `author`, `publishedAt`, `updatedAt`, `summary`, `category`,
 *   `tags`, `thumbnailUrl`, `externalId`, `paragraphs`, `multipage`, `rawHtml`).
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape.
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  const fieldProvenance = {};
  if (draft.multipage) {
    fieldProvenance.content_text = {
      source: draft.multipage.pagesFetched > 1 ? 'dom_multipage_merge' : 'dom_single_page',
      pages_detected: draft.multipage.totalPages,
      pages_merged: draft.multipage.pagesFetched,
      note: draft.multipage.note,
    };
  }
  if (draft.externalId) {
    fieldProvenance.external_article_id = { source: 'dataLayer.articleContentId' };
  }

  return {
    external_article_id: draft.externalId || undefined,
    canonical_url: draft.url ? stripPageParam(draft.url) : undefined,
    title: draft.title,
    content_text: contentText,
    content_html: contentHtml,
    summary: draft.summary || undefined,
    author_name: draft.author,
    category: draft.category || undefined,
    tags: Array.isArray(draft.tags) && draft.tags.length > 0 ? draft.tags : undefined,
    thumbnail_url: draft.thumbnailUrl || undefined,
    published_at: draft.publishedAt,
    updated_at_source: draft.updatedAt,
    language: 'id',
    parser_version: ADAPTER_VERSION,
    field_provenance: Object.keys(fieldProvenance).length > 0 ? fieldProvenance : undefined,
  };
}

/**
 * @returns {import('../../core/types').SourceProfile & {sourceId: string, displayName: string, baseUrl: string, crawlIntervalMinutes: number, overlapHours: number}}
 */
function getSourceProfile() {
  const raw = rawSuara.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer.
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
  return rawSuara.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawSuara.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawSuara.parse(html, ctx);
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
};
