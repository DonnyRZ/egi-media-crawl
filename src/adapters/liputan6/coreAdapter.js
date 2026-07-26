'use strict';

const rawLiputan6 = require('./index');

/**
 * Contract-adapter layer for the Liputan6 adapter (Sprint 3, S3-B) -> crawler core (F3) +
 * db layer (F6). Mirrors `src/adapters/detik/coreAdapter.js` / `src/adapters/viva/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template`
 * contract (camelCase); this module maps that to the snake_case shape `src/core/
 * pipeline.js` + `src/db/**` expect (see `src/core/types.js`), and back-fills
 * `sourceId`/`displayName`/... camelCase aliases onto the profile object for
 * `src/sources/registry.js`.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Liputan6, and how much we
 * trust it. "Hybrid" sources merge JSON-LD (`NewsArticle`, no `articleBody`) with the DOM.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                          | Fallback(s)                              | Confidence | Notes |
 * |------------------------|------------------------------------------|--------------------------------------------|------------|-------|
 * | canonical_url          | `og:url`                                 | JSON-LD `mainEntityOfPage`, `ctx.url`      | high       | No `<link rel="canonical">` observed live; `page` query param defensively stripped even though Liputan6 doesn't use one (see multipage note below). |
 * | title                  | JSON-LD `headline`                       | DOM `.read-page--header--title`, `og:title`, `<title>` | high | |
 * | summary                | JSON-LD `description`                    | `og:description`, `meta[name=description]`, DOM `.read-page--header--description p` | medium | |
 * | content_text/html      | DOM, ALL `.article-content-body__item-page[data-page]` blocks merged | — | high | **Same-document multipage**: every page of a multipage article ships in ONE HTML response as sibling `data-page="N"` blocks — no extra HTTP fetch is ever needed or performed. `.baca-juga-collections` ("Baca Juga") + ad markup stripped per block before extraction. See `pages_merged` in `field_provenance` below. |
 * | author_name            | JSON-LD `author[0].name`                 | DOM `.read-page-box__author__name`         | medium     | |
 * | published_at           | JSON-LD `datePublished`                  | `meta[property="article:published_time"]` | high       | Both carry a `+07:00` offset live, so no naive-timezone guessing is needed here (unlike suara). |
 * | updated_at_source      | JSON-LD `dateModified`                   | `meta[property="article:modified_time"]`  | medium     | |
 * | category               | DOM breadcrumb (last/most-specific item, e.g. "Politik") | URL `{channel}` segment (e.g. "news") | medium | No `articleSection` in JSON-LD live. |
 * | thumbnail_url          | JSON-LD `image.url`                      | `og:image`                                  | medium–high | |
 * | tags                   | `meta[name="keywords"]` (comma-split)    | —                                            | low        | No reliable per-article tag DOM list found live (same gap as VIVA). |
 * | external_article_id    | Numeric id parsed from the URL (`/read/{id}/`) | `article[data-article-id]`            | high       | Same id across every `data-page` block (single document). |
 * | language               | Hardcoded `"id"`                         | —                                            | high       | Liputan6 is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from
 * this same matrix in `buildFieldProvenance()` below.
 */

// Bumped independently from the raw adapter's internal version if its parsing logic
// changes; stored on every article row (articles.adapter_version / parser_version).
const ADAPTER_VERSION = 'liputan6_v1';

/**
 * @param {string|undefined} hint - listing `time[datetime]` value (already ISO8601 w/
 *   offset live) or a fixture placeholder; kept defensive since `discovered_urls.
 *   published_hint` is TIMESTAMPTZ and must only be set when it actually parses.
 * @returns {string|undefined}
 */
function tryParseHint(hint) {
  if (!hint) return undefined;
  const parsed = new Date(hint);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {import('./index').DiscoveredItem} item - raw adapter shape (camelCase).
 * @returns {import('../../core/types').DiscoveryItem} core shape (snake_case).
 */
function toCoreDiscoveryItem(item) {
  return {
    url: item.rawUrl,
    channel: item.discoveryChannel || 'unknown',
    external_id: item.externalId,
    title_hint: item.listingTitle,
    published_hint: tryParseHint(item.publishedHint),
    category_hint: item.categoryHint,
    metadata: item.normalizedUrl ? { normalizedUrlHint: item.normalizedUrl } : undefined,
  };
}

/**
 * Builds the `field_provenance` JSONB payload documented in the field matrix above.
 * @param {ReturnType<typeof rawLiputan6.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(draft) {
  return {
    canonical_url: { source: 'og:url|json_ld:mainEntityOfPage|ctx.url', confidence: 'high' },
    title: { source: 'json_ld:headline|dom:.read-page--header--title|og:title', confidence: 'high' },
    summary: {
      source: 'json_ld:description|og:description|meta:description|dom:.read-page--header--description',
      confidence: 'medium',
    },
    content_text: {
      source: 'dom:.article-content-body__item-page[data-page] (same-document multipage merge)',
      confidence: 'high',
      pages_merged: draft.pagesMerged || 1,
    },
    author_name: { source: 'json_ld:author[0].name|dom:.read-page-box__author__name', confidence: 'medium' },
    published_at: { source: 'json_ld:datePublished|meta:article:published_time', confidence: 'high' },
    updated_at_source: { source: 'json_ld:dateModified|meta:article:modified_time', confidence: 'medium' },
    category: { source: 'dom:breadcrumb_last_item|url_channel_segment', confidence: 'medium' },
    thumbnail_url: { source: 'json_ld:image.url|og:image', confidence: 'medium' },
    tags: { source: 'meta:keywords', confidence: 'low' },
    external_article_id: { source: 'url_path_id|dom:article[data-article-id]', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawLiputan6.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url || undefined,
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
    field_provenance: buildFieldProvenance(draft),
  };
}

/**
 * @returns {import('../../core/types').SourceProfile & {sourceId: string, displayName: string, baseUrl: string, crawlIntervalMinutes: number, overlapHours: number}}
 */
function getSourceProfile() {
  const raw = rawLiputan6.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['www.liputan6.com'],
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
  return rawLiputan6.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawLiputan6.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawLiputan6.parse(html, ctx);
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
  buildFieldProvenance,
};
