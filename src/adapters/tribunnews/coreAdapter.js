'use strict';

const rawTribunnews = require('./index');

/**
 * Contract-adapter layer for the Tribunnews adapter (Sprint 6b, S6b-C) -> crawler core (F3) +
 * db layer (F6). Mirrors `src/adapters/tempo/coreAdapter.js` / `src/adapters/viva/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template` contract
 * (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js` +
 * `src/db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * Registered into `src/adapters/index.js`'s ADAPTER_MODULES map by S6b-D (see the bottom of
 * this file for the registry snippet); S6b-D also adds this adapter's `sample-article.html`
 * fixture entry to `src/workers/lib/fetchHtml.js`'s FIXTURE_PATHS map.
 *
 * Secondary discovery channel is `sitemap-news.xml`, NOT RSS — the task brief's suggested RSS
 * feed was verified live to always return the bare homepage URL as every item's `<link>`, i.e.
 * genuinely broken for discovery on the live site today; see `index.js` module header
 * "Discovery, secondary" for the full live-verification trail.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Tribunnews, and how much we trust
 * it. Tribunnews is a **hybrid JSON-LD `@graph` + DOM** source (per task brief): the JSON-LD
 * `NewsArticle` entry carries most metadata (including `isAccessibleForFree`, handled exactly
 * like Tempo's own field of the same name — see below), while the body itself is DOM-only (no
 * `articleBody` in JSON-LD, unlike Tempo). See `index.js`'s module header for the full
 * live-verification notes this table summarizes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                                  | Confidence | Notes |
 * |------------------------|------------------------------------------------|-------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                        | `og:url`, JSON-LD `mainEntityOfPage['@id']`     | high       | `page` query param always stripped; multipage pages' own canonical/`og:url` never carries it live either. |
 * | title                  | JSON-LD `headline`                              | DOM `h1#arttitle`, `og:title` (" - Tribunnews.com" suffix stripped), `<title>` | high | |
 * | summary                | JSON-LD `description`                           | `og:description`, `meta[name=description]`     | high       | Page-2+ variants' own meta carries a trailing " - Halaman N" suffix, stripped defensively. |
 * | content_text/html      | DOM `div.side-article.txt-article` (all merged pages) | —                                  | high (low when `isAccessibleForFree=false`) | "Ringkasan Berita:" recap blockquote, "Baca juga" links, ad slots, and figure/figcaption stripped before extraction; multipage articles merge paragraphs from every `?page=N` in reading order. |
 * | author_name            | JSON-LD `author[].name`, deduplicated           | DOM `#penulis a`                                | medium     | `#editor a` is a different role/person, deliberately never folded in (no N5 column for it). |
 * | published_at           | JSON-LD `datePublished`                         | DOM `time[datetime]`                            | high       | Full ISO 8601 with an explicit `+07:00` offset already in JSON-LD — no "assume WIB" guessing needed. |
 * | updated_at_source      | JSON-LD `dateModified`                          | —                                                | medium     | |
 * | category               | JSON-LD `articleSection`                        | Breadcrumb JSON-LD last non-"Home" item, URL `{section}` segment | medium | `articleSection` matches the URL's own `{section}` (e.g. "Internasional"); breadcrumb's last item is one level MORE specific (e.g. "Amerika") and is only used if `articleSection` is absent. |
 * | thumbnail_url          | JSON-LD `image.url`                             | `og:image`                                       | medium–high | |
 * | tags                   | JSON-LD `keywords` (flat string array)          | DOM `h5.tagcloud3 a.rd2` tag-pill widget        | medium     | |
 * | external_article_id    | Numeric `{numericId}` URL segment (`/{section}/{numericId}/{slug}` shape) | DOM `[data-content-id]` / `meta[property=android:app_id]` (needed for the `/{section}/{yyyy}/{mm}/{dd}/{slug}` shape, which carries no id in the URL at all) | high | Two live-verified URL shapes — see index.js module header "Article URL shape". |
 * | language               | Hardcoded `"id"`                                | —                                                | high       | Tribunnews is Indonesian-only. |
 *
 * **`isAccessibleForFree` / paywall gating**: JSON-LD `isAccessibleForFree` (verified live
 * `true` on every sampled article — no live paywalled/"Premium" sample was directly observed
 * during this assessment, though the site's own `/index-news` category filter DOES list a
 * `"premium"` option, so the schema field is real infrastructure here, not invented) is
 * surfaced via `content_text`'s `field_provenance` confidence, which drops to `"low"` whenever
 * `isAccessibleForFree === false` — mirroring Tempo's own `isAccessibleForFree` confidence-drop
 * pattern exactly, per the task brief's own peer-reference instruction. The extracted
 * `content_text` in that case is documented as a likely teaser, never padded/faked to look like
 * a full body. `fixtures/tribunnews/sample-article-premium.html` exercises this path offline
 * (synthetic, since no live sample was available to fixture — see index.js module header).
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'tribunnews_v1';

/**
 * @param {string|undefined} hint - the raw adapter's `publishedHint` is already resolved to
 *   ISO 8601 (or `undefined`) by `index.js`'s own `parseIndonesianDateTime()` (listing) /
 *   `toIsoOrUndefined()` (sitemap `news:publication_date`) — this is a thin pass-through kept
 *   for symmetry with every sibling coreAdapter's own `tryParseHint()`, and as a defensive
 *   re-validation in case a future raw parser change starts returning raw strings.
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
 * @param {ReturnType<typeof rawTribunnews.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(draft) {
  const isPaywalled = draft && draft.isAccessibleForFree === false;
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'jsonld:headline|dom:h1#arttitle|og:title|title', confidence: 'high' },
    summary: { source: 'jsonld:description|og:description|meta:description', confidence: 'high' },
    content_text: {
      source: 'dom:div.side-article.txt-article',
      confidence: isPaywalled ? 'low' : 'high',
      note: isPaywalled ? 'jsonld:isAccessibleForFree=false — content_text is a short teaser only, not a parsing bug' : undefined,
      pages_merged: draft.pagesMerged || 1,
    },
    author_name: { source: 'jsonld:author[].name_deduped|dom:#penulis_a', confidence: 'medium' },
    published_at: { source: 'jsonld:datePublished|dom:time[datetime]', confidence: 'high' },
    updated_at_source: { source: 'jsonld:dateModified', confidence: 'medium' },
    category: { source: 'jsonld:articleSection|jsonld:breadcrumb_last_non_home_item|url_section_segment', confidence: 'medium' },
    thumbnail_url: { source: 'jsonld:image.url|og:image', confidence: 'medium' },
    tags: { source: 'jsonld:keywords|dom:h5.tagcloud3_a.rd2', confidence: 'medium' },
    external_article_id: { source: 'url_numeric_id_segment|dom:[data-content-id]|meta:android:app_id', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawTribunnews.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.canonicalUrl || (draft.url ? rawTribunnews.stripPageParam(draft.url) : undefined),
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
  const raw = rawTribunnews.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    // Tight scope per task brief: `www.tribunnews.com` ONLY — no regional Tribun Network
    // siblings, no mobile mirror. See index.js module header.
    allowed_domains: ['www.tribunnews.com'],
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
  return rawTribunnews.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawTribunnews.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawTribunnews.parse(html, ctx);
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
// "tribunnews"); see that file for the full registry.
// ---------------------------------------------------------------------------------
