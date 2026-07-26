'use strict';

const rawMerdeka = require('./index');

/**
 * Contract-adapter layer for the Merdeka.com adapter (Sprint 6b, S6b-A) -> crawler core (F3) +
 * db layer (F6). Mirrors `src/adapters/idn_times/coreAdapter.js`'s bridge pattern exactly:
 * `./index.js` implements the `_template` contract (camelCase); this module maps that to the
 * snake_case shape `src/core/pipeline.js` + `src/db/**` expect (see `src/core/types.js`), and
 * back-fills `sourceId`/`displayName`/... camelCase aliases onto the profile object for
 * `src/sources/registry.js`.
 *
 * Registered into `src/adapters/index.js`'s ADAPTER_MODULES map by S6b-D:
 *
 *   merdeka: () => require('./merdeka/coreAdapter'),
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Merdeka.com, and how much we
 * trust it. See `index.js`'s module header for the full live-verification notes this table
 * summarizes. "Hybrid" per the task brief: JSON-LD + `<meta>` tags + body DOM.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                                  | Fallback(s)                                       | Confidence | Notes |
 * |------------------------|--------------------------------------------------|------------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                          | `og:url`, JSON-LD `NewsArticle.url`                  | high       | Query string always stripped defensively (robots `Disallow: /*?`). |
 * | title                  | `NewsArticle` JSON-LD `headline`                  | DOM `h1.articles-content__title`, `og:title`, `<title>` | high    | |
 * | summary                | `meta[name=description]`                          | JSON-LD `description`, DOM `.articles-content__sinopsis` | medium  | |
 * | content_text/html      | DOM `.articles-content__body > p` (direct children) | —                                                   | high       | Verified live a multipage article's ENTIRE content is pre-merged into one fetch — see `index.js` "Multipage articles" note. Ad-slot/"Baca Juga" noise excluded for free by the direct-child selector. |
 * | author_name            | `meta[name="author"]`                             | DOM `[data-tracking=author_name]`, `window.kly.article.reporters` | high | JSON-LD `author[0].name` verified live to always be `null` — never used. |
 * | published_at           | `meta[property="article:published_time"]`         | JSON-LD `datePublished`                              | high       | Both verified live to always carry an explicit `+07:00` offset. |
 * | updated_at_source      | `meta[property="article:modified_time"]`          | JSON-LD `dateModified`                               | high       | |
 * | category               | DOM `nav.breadcrumb-navigation` last `<li>`       | `window.kly.category.name`                           | high       | `BreadcrumbList` JSON-LD verified live USELESS here (last item is the article's own title, not a subcategory). |
 * | thumbnail_url          | JSON-LD `NewsArticle.image[0]`                    | `og:image`                                            | high       | |
 * | tags                   | DOM `.tags-articles__list a`                      | `meta[name=keywords]` (comma split), JSON-LD `keywords` (comma split) | medium | |
 * | external_article_id    | Bare numeric id parsed from URL `/read/{id}/`     | —                                                      | high       | |
 * | language               | Hardcoded `"id"`                                  | —                                                      | high       | Merdeka.com is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'merdeka_v1';

/**
 * The raw adapter's `publishedHint` (when present — only the sitemap discovery channel
 * supplies one; the category-hub channel's own `<time>` sibling is always empty live, see
 * `index.js`'s `extractHubItems()` doc) is already resolved to an ISO 8601 string by
 * `rawMerdeka.extractSitemapItems()`'s own `Date(...).toISOString()` call — this is a thin
 * pass-through kept for symmetry with every sibling coreAdapter's own `tryParseHint()`, and as
 * a defensive re-validation in case a future raw parser change starts returning raw strings.
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
    metadata: {
      ...(item.normalizedUrl ? { normalizedUrlHint: item.normalizedUrl } : {}),
      ...(Array.isArray(item.tagsHint) && item.tagsHint.length > 0 ? { tagsHint: item.tagsHint } : {}),
    },
  };
}

/**
 * Builds the `field_provenance` JSONB payload documented in the field matrix above.
 * @returns {Object}
 */
function buildFieldProvenance() {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:NewsArticle.url', confidence: 'high' },
    title: { source: 'jsonld:NewsArticle.headline|dom:h1.articles-content__title|og:title|title', confidence: 'high' },
    summary: { source: 'meta:description|jsonld:NewsArticle.description|dom:.articles-content__sinopsis', confidence: 'medium' },
    content_text: {
      source: 'dom:.articles-content__body_>_p',
      confidence: 'high',
      note: 'multipage articles verified live to be fully pre-merged into a single fetch; no extra network I/O performed',
    },
    author_name: {
      source: 'meta:author|dom:[data-tracking=author_name]|window.kly.article.reporters',
      confidence: 'high',
      note: 'jsonld:NewsArticle.author[0].name verified live to always be null — never used',
    },
    published_at: { source: 'meta:article:published_time|jsonld:NewsArticle.datePublished', confidence: 'high' },
    updated_at_source: { source: 'meta:article:modified_time|jsonld:NewsArticle.dateModified', confidence: 'high' },
    category: {
      source: 'dom:nav.breadcrumb-navigation_last_li|window.kly.category.name',
      confidence: 'high',
      note: 'jsonld:BreadcrumbList verified live useless here (last item is the article title, not a subcategory)',
    },
    thumbnail_url: { source: 'jsonld:NewsArticle.image[0]|og:image', confidence: 'high' },
    tags: { source: 'dom:.tags-articles__list_a|meta:keywords|jsonld:NewsArticle.keywords', confidence: 'medium' },
    external_article_id: { source: 'url_path_read_segment_numeric_id', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawMerdeka.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawMerdeka.stripQueryString(draft.url) : undefined,
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
    field_provenance: buildFieldProvenance(),
  };
}

/**
 * @returns {import('../../core/types').SourceProfile & {sourceId: string, displayName: string, baseUrl: string, crawlIntervalMinutes: number, overlapHours: number}}
 */
function getSourceProfile() {
  const raw = rawMerdeka.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: [rawMerdeka.ALLOWED_HOST],
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
  return rawMerdeka.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawMerdeka.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawMerdeka.parse(html, ctx);
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
// "merdeka"); see that file for the full registry.
// ---------------------------------------------------------------------------------
