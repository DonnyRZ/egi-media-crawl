'use strict';

const rawBeritasatu = require('./index');

/**
 * Contract-adapter layer for the BeritaSatu adapter (Sprint 6b, S6b-B) -> crawler core (F3) +
 * db layer (F6). Mirrors `src/adapters/media_indonesia/coreAdapter.js` / `src/adapters/tempo/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template` contract
 * (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js` +
 * `src/db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * NOTE: this adapter is registered into `src/adapters/index.js`'s ADAPTER_MODULES map by
 * S6b-D (see the bottom of this file for the registry snippet), which also adds this source's
 * `sample-article.html` fixture entry to `src/workers/lib/fetchHtml.js`'s FIXTURE_PATHS map.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for BeritaSatu, and how much we trust
 * it. This site is unusual in this codebase for shipping a flat, valid-JSON
 * `window.dataLayer.push({...})` metadata blob directly in `<head>` (see `index.js`'s module
 * header "dataLayer" note) — treated as PRIMARY for `category`/`tags`/`external_article_id`/
 * `author_name` ahead of JSON-LD/DOM, since it was independently verified live to be complete
 * and self-consistent across 3+ samples spanning distinct kanal. See `index.js`'s module header
 * for the full live-verification notes this table summarizes, including the CloudFront
 * restricted-assessment UA rationale.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                                  | Confidence | Notes |
 * |------------------------|------------------------------------------------|-------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                        | `og:url`, JSON-LD `mainEntityOfPage['@id']`     | high       | `page` query param stripped defensively (brief: `?page=` is ignored here anyway). |
 * | title                  | JSON-LD `headline`                              | `og:title`, DOM `<h1>`, `<title>`               | high       | |
 * | summary                | JSON-LD `description`                           | `og:description`, `meta[name=description]`     | high       | |
 * | content_text/html      | DOM `div.body-content`                          | —                                                | high       | "BACA JUGA" recirculation box (whole wrapper div, label + linked related-article `<h2>`) stripped before extraction; ad-slot `<div>`/`<script>`/`<style>` naturally excluded (only `p`/`h2` selected). No premium/teaser gate was observed live on any sampled article (incl. the `bplus` in-depth vertical) — no confidence-drop heuristic is implemented here, unlike Tempo/Media Indonesia. |
 * | author_name            | `dataLayer.penulis` (reporter byline)           | JSON-LD `author[].name`, DOM `a[href*=/penulis/]` | medium   | Verified live to match JSON-LD `author[].name` on every sample — no Republika-style "Red:"-vs-"Rep:" ambiguity here. |
 * | published_at           | JSON-LD `datePublished` (full ISO 8601, explicit `+07:00`) | `dataLayer.detail_published_date` ("Weekday, D Month YYYY \| HH:MM WIB") | high | No "assume WIB" guessing needed for the primary source, same as Tempo/Kumparan. |
 * | updated_at_source      | JSON-LD `dateModified`                          | —                                                | medium     | Verified live always present but always EQUAL to `datePublished` — no distinct "last updated" signal was ever observed on this site. |
 * | category               | `dataLayer.sub_category` (most specific)        | `dataLayer.content_category`, JSON-LD breadcrumb last non-Home item, `{kanal}` URL segment | medium | JSON-LD `BreadcrumbList` is genuinely shallow here (only `[Home, {kanal}]`, no sub-kanal level) — `dataLayer.sub_category` is the actually-informative signal, unlike Tempo/Media Indonesia's breadcrumb-based category. |
 * | thumbnail_url          | JSON-LD `image.url` (an `ImageObject`, not a bare string) | `og:image`                              | medium–high | |
 * | tags                   | `dataLayer.tags` (comma-separated string)       | DOM tag-pill widget (`a[href^=/tag/] h3.badge`) | medium     | Verified live to match the DOM tag-pill widget exactly on the same sample; no leading "#" marker to strip here (unlike Media Indonesia). |
 * | external_article_id    | `dataLayer.article_id`                          | Numeric `{numericId}` URL path segment (`/{kanal}/{numericId}/{slug}`) | high | Verified live IDENTICAL to the URL's own numeric segment on every sample. |
 * | language               | Hardcoded `"id"`                                | —                                                | high       | BeritaSatu is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'beritasatu_v1';

/**
 * The raw adapter's `publishedHint` is already resolved to ISO 8601 (or `undefined`) by
 * `rawBeritasatu.extractSitemapUrls()`'s own `toIsoOrUndefined()` call inside `index.js` — this
 * is a thin pass-through kept for symmetry with every sibling coreAdapter's own `tryParseHint()`,
 * and as a defensive re-validation in case a future raw parser change starts returning raw
 * strings.
 * @param {string|undefined} hint
 * @returns {string|undefined} ISO 8601 string, or undefined if unparseable/absent.
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
 * @param {ReturnType<typeof rawBeritasatu.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(_draft) {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'jsonld:headline|og:title|dom:h1|title', confidence: 'high' },
    summary: { source: 'jsonld:description|og:description|meta:description', confidence: 'high' },
    content_text: { source: 'dom:.body-content', confidence: 'high' },
    author_name: { source: 'datalayer:penulis|jsonld:author[].name|dom:a[href*=/penulis/]', confidence: 'medium' },
    published_at: { source: 'jsonld:datePublished|datalayer:detail_published_date', confidence: 'high' },
    updated_at_source: { source: 'jsonld:dateModified', confidence: 'medium' },
    category: { source: 'datalayer:sub_category|datalayer:content_category|jsonld:breadcrumb_last_non_home|url_kanal_segment', confidence: 'medium' },
    thumbnail_url: { source: 'jsonld:image.url|og:image', confidence: 'medium' },
    tags: { source: 'datalayer:tags|dom:a[href^=/tag/]_h3.badge', confidence: 'medium' },
    external_article_id: { source: 'datalayer:article_id|url_path_numeric_id_segment', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawBeritasatu.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawBeritasatu.stripPageParam(draft.url) : undefined,
    title: draft.title,
    summary: draft.summary || undefined,
    content_text: contentText,
    content_html: contentHtml,
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
  const raw = rawBeritasatu.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['www.beritasatu.com', 'beritasatu.com'],
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
  return rawBeritasatu.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawBeritasatu.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawBeritasatu.parse(html, ctx);
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

// ---------------------------------------------------------------------------------
// Registered into `src/adapters/index.js`'s ADAPTER_MODULES map by S6b-D (source_id
// "beritasatu"); see that file for the full registry.
// ---------------------------------------------------------------------------------
