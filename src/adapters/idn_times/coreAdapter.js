'use strict';

const rawIdnTimes = require('./index');

/**
 * Contract-adapter layer for the IDN Times adapter (Sprint 6a, S6a-A) -> crawler core (F3) +
 * db layer (F6). Mirrors `src/adapters/tirto/coreAdapter.js` / `src/adapters/okezone/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template` contract
 * (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js` +
 * `src/db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * Registered into `src/adapters/index.js`'s ADAPTER_MODULES map by S6a-D:
 *
 *   idn_times: () => require('./idn_times/coreAdapter'),
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for IDN Times, and how much we trust
 * it. See `index.js`'s module header for the full live-verification notes this table
 * summarizes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                                  | Fallback(s)                                       | Confidence | Notes |
 * |------------------------|--------------------------------------------------|------------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                          | `og:url`, `WebPage` JSON-LD `url`                    | high       | |
 * | title                  | `NewsArticle` JSON-LD `headline`                  | DOM `h1[data-testid=title-article]`, `og:title`, `<title>` | high  | |
 * | summary                | `NewsArticle` JSON-LD `description`               | `og:description`, `meta[name=description]`          | medium     | Verified live `description` can be an empty string; when empty, `og:description`/`meta:description` were ALSO verified to just duplicate the headline (not a real synopsis) — so this can be low-information (title-only) but is never absent. |
 * | content_text/html      | DOM `#article-description p.article-text`        | `NewsArticle` JSON-LD `articleBody` (single blob, last resort) | high | `articleBody` has no paragraph boundaries live (sentences run together) — only used when the DOM selector yields zero paragraphs. |
 * | author_name            | `NewsArticle` JSON-LD `author[0].name`            | DOM `[data-testid=author-article-1]`                 | high       | |
 * | published_at           | `NewsArticle` JSON-LD `datePublished` (`+07:00` always present) | DOM `[data-testid=publish-date-article] time[datetime]` | high | No no-tz ambiguity here (unlike okezone/tirto's `dateModified`) — both JSON-LD date fields carry an explicit offset live. |
 * | updated_at_source      | `NewsArticle` JSON-LD `dateModified` (`+07:00` always present) | —                                       | high       | |
 * | category               | `WebPage` JSON-LD `breadcrumb.itemListElement`, last non-"Home" item | DOM `[data-testid^=breadcrumbs-]` spans, last non-"Home" | high | |
 * | thumbnail_url          | `NewsArticle` JSON-LD `image.url`                 | `og:image`                                            | high       | |
 * | tags                   | `NewsArticle` JSON-LD `keywords` (filtered of a known junk entry, "Update me") | DOM `[data-testid=tag-list] a` text list | medium | Verified live `keywords` can include the literal junk string `"Update me"` on at least one sample — filtered out. |
 * | external_article_id    | `{authorCode}-{articleCode}` (5-char + 6-char trailing URL tokens) | —                                | high       | The bare 6-char `articleCode` alone was verified live to collide across two differently-authored URLs for what looks like the same underlying article — both tokens are combined to stay collision-resistant. |
 * | language               | Hardcoded `"id"`                                  | —                                                      | high       | IDN Times' main `www.idntimes.com` site is Indonesian-only (English-language IDN Times exists on a different property, out of scope here). |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'idn_times_v1';

/**
 * The raw adapter's `publishedHint` is already resolved to an ISO 8601 string (or `undefined`)
 * by `rawIdnTimes.parseListingDateTime()` inside `index.js`'s listing extractor — this is a
 * thin pass-through kept for symmetry with every sibling coreAdapter's own `tryParseHint()`,
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
 * @returns {Object}
 */
function buildFieldProvenance() {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:WebPage.url', confidence: 'high' },
    title: { source: 'jsonld:NewsArticle.headline|dom:h1[data-testid=title-article]|og:title|title', confidence: 'high' },
    summary: {
      source: 'jsonld:NewsArticle.description|og:description|meta:description',
      confidence: 'medium',
      note: 'description can be empty live; og/meta description can then just duplicate the headline',
    },
    content_text: {
      source: 'dom:#article-description_p.article-text',
      confidence: 'high',
      fallback: 'jsonld:NewsArticle.articleBody (single blob, no paragraph boundaries)',
    },
    author_name: { source: 'jsonld:NewsArticle.author[0].name|dom:[data-testid=author-article-1]', confidence: 'high' },
    published_at: { source: 'jsonld:NewsArticle.datePublished|dom:[data-testid=publish-date-article]_time[datetime]', confidence: 'high' },
    updated_at_source: { source: 'jsonld:NewsArticle.dateModified', confidence: 'high' },
    category: { source: 'jsonld:WebPage.breadcrumb_last_non_home_item|dom:[data-testid^=breadcrumbs-]_last_item', confidence: 'high' },
    thumbnail_url: { source: 'jsonld:NewsArticle.image.url|og:image', confidence: 'high' },
    tags: {
      source: 'jsonld:NewsArticle.keywords_filtered|dom:[data-testid=tag-list]_a',
      confidence: 'medium',
      note: 'keywords filtered of a known junk entry ("Update me") observed live',
    },
    external_article_id: { source: 'url_trailing_authorCode5_articleCode6_pair', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawIdnTimes.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawIdnTimes.stripTrackingParams(draft.url) : undefined,
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
  const raw = rawIdnTimes.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    // Explicit single host (per task brief: `www.idntimes.com`, NOT `*.idntimes.com`) — see
    // `index.js`'s `ALLOWED_HOST`/module header "Host scope" note on why a blind wildcard
    // would wrongly admit the many live "hyperlocal" regional subdomains (e.g.
    // `bali.idntimes.com`, `jatim.idntimes.com`), which are a different template/content pool.
    allowed_domains: [rawIdnTimes.ALLOWED_HOST],
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
  return rawIdnTimes.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawIdnTimes.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawIdnTimes.parse(html, ctx);
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
// Wired into `src/adapters/index.js`'s ADAPTER_MODULES map by S6a-D:
//
//   idn_times: () => require('./idn_times/coreAdapter'),
// ---------------------------------------------------------------------------------
