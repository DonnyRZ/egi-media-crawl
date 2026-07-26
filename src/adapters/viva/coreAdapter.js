'use strict';

const rawViva = require('./index');
const { parseListingDateIso } = require('../../core/parseListingDate');

/**
 * Contract-adapter layer for the VIVA adapter (Pilot P3) -> crawler core (F3) + db
 * layer (F6). Mirrors `src/adapters/detik/coreAdapter.js`'s bridge pattern exactly:
 * `./index.js` implements the `_template` contract (camelCase); this module maps that
 * to the snake_case shape `src/core/pipeline.js` + `src/db/**` expect (see
 * `src/core/types.js`), and back-fills `sourceId`/`displayName`/... camelCase aliases
 * onto the profile object for `src/sources/registry.js`.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for VIVA, and how much we
 * trust it. "Hybrid" sources merge JSON-LD (`NewsArticle`, no `articleBody`) with the
 * DOM (`.main-content-detail`), per the assessment notes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                          | Fallback(s)                          | Confidence | Notes |
 * |------------------------|------------------------------------------|----------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                 | `og:url`, JSON-LD `mainEntityOfPage`   | high       | `page` query param always stripped (multipage canonical must not carry it). |
 * | title                  | JSON-LD `headline`                       | DOM `.main-title`, `og:title`, `<title>` | high     | |
 * | summary                | JSON-LD `description`                    | `og:description`, `meta[name=description]` | medium | Teaser/SEO text; optional under N5. |
 * | content_text/html      | DOM `.main-content-detail` (all merged pages) | —                                  | high       | `.recommended-article` ("Baca Juga") + ad slots stripped before extraction; multipage articles merge paragraphs from every `?page=N` in reading order. |
 * | author_name            | JSON-LD `author.name`                    | DOM `.date-time .author`               | medium     | Bylines are frequently a desk/team name rather than a person. |
 * | published_at           | JSON-LD `datePublished`                  | DOM `time.date[datetime]`              | high       | Preferred over `dateModified` per assessment notes. |
 * | updated_at_source      | JSON-LD `dateModified`                   | —                                       | low        | Assessment notes flag `dateModified` as often unreliable on this source; carried through for completeness only, never used to override `published_at`. |
 * | category               | JSON-LD `articleSection`                 | URL `{kanal}` segment (discovery-time hint only, not set on the parsed article) | medium | |
 * | thumbnail_url          | JSON-LD `image.url`                      | `og:image`, twitter:image, DOM hero img | medium–high | Hardened after pilot: no longer JSON-LD-only. |
 * | external_article_id    | Numeric id parsed from the URL path (`/{id}-{slug}`) | —                          | high       | Same id across all `?page=N` variants. |
 * | language               | Hardcoded `"id"`                         | —                                       | high       | VIVA is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated
 * from this same matrix in `buildFieldProvenance()` below, keyed by snake_case field
 * name, so downstream auditing doesn't need to re-derive it from this comment.
 */

// Bumped independently from the raw adapter's internal version if its parsing logic
// changes; stored on every article row (articles.adapter_version / parser_version).
const ADAPTER_VERSION = 'viva_v1_1';

/**
 * Listing `.article-list-date span` text is a human-readable Indonesian string; parse via
 * shared `parseListingDateIso` (same helper overlap-stop uses).
 * @param {string|undefined} hint
 * @returns {string|undefined} ISO 8601 string, or undefined if unparseable/absent.
 */
function tryParseHint(hint) {
  return parseListingDateIso(hint);
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
 * @param {ReturnType<typeof rawViva.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(draft) {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|json_ld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'json_ld:headline', confidence: 'high' },
    summary: { source: 'json_ld:description|og:description|meta:description', confidence: 'medium' },
    content_text: {
      source: 'dom:.main-content-detail',
      confidence: 'high',
      pages_merged: draft.pagesMerged || 1,
    },
    author_name: { source: 'json_ld:author.name', confidence: 'medium' },
    published_at: { source: 'json_ld:datePublished', confidence: 'high' },
    updated_at_source: { source: 'json_ld:dateModified', confidence: 'low' },
    category: { source: 'json_ld:articleSection', confidence: 'medium' },
    thumbnail_url: {
      source: 'json_ld:image.url|og:image|twitter:image|dom:hero',
      confidence: 'medium',
    },
    external_article_id: { source: 'url_path_id', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawViva.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalId || undefined,
    canonical_url: draft.canonicalUrl || draft.url || undefined,
    title: draft.title,
    summary: draft.summary || undefined,
    content_text: contentText,
    content_html: contentHtml,
    author_name: draft.author,
    category: draft.category || undefined,
    thumbnail_url: draft.thumbnailUrl || undefined,
    published_at: draft.publishedAt,
    updated_at_source: draft.updatedAt,
    language: 'id',
    parser_version: ADAPTER_VERSION,
    field_provenance: buildFieldProvenance(draft),
    // `tags` intentionally omitted: VIVA's article template has no reliable tag selector
    // (confirmed against the live fixture — no `.article-tags`/`.detail__body-tag`-equivalent
    // element exists), so `./index.js` never extracts one. Tracked as a gap-audit P1 note
    // rather than invented — revisit if a real selector is found on a future template pass.
  };
}

/**
 * @returns {import('../../core/types').SourceProfile & {sourceId: string, displayName: string, baseUrl: string, crawlIntervalMinutes: number, overlapHours: number}}
 */
function getSourceProfile() {
  const raw = rawViva.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['www.viva.co.id'],
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
  return rawViva.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawViva.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawViva.parse(html, ctx);
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
