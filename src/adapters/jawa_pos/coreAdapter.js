'use strict';

const rawJawaPos = require('./index');

/**
 * Contract-adapter layer for the Jawa Pos adapter (Sprint 4, S4-C) -> crawler core (F3) + db
 * layer (F6). Mirrors `src/adapters/tirto/coreAdapter.js` / `src/adapters/cnn_indonesia/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template` contract
 * (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js` + `src/
 * db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * NOTE: registered in `src/adapters/index.js` by S4-D (this file does not touch that file, per
 * Sprint 4 exclusive-ownership rules). See the bottom of this file for the registry snippet
 * that was wired in.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Jawa Pos, and how much we trust
 * it. Unlike tirto/CNN Indonesia/Liputan6, Jawa Pos ships NO `NewsArticle` (or any `Article`)
 * JSON-LD block at all (verified live 2026-07-24 — only `WebSite` + `NewsMediaOrganization`);
 * the PRIMARY source for every field below is the page's `__NEXT_DATA__` JSON blob
 * (`props.pageProps.article`, a GraphQL `Article` node), NOT DOM selectors — see `index.js`
 * header for the live-verification notes this table summarizes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                    | Confidence | Notes |
 * |------------------------|------------------------------------------------|----------------------------------|------------|-------|
 * | canonical_url          | `__NEXT_DATA__` article.category.slug + article_id + slug | `link[rel=canonical]`, `og:url` | high | `page` query param stripped defensively (verified live it never actually changes the response — see `index.js`). |
 * | title                  | `__NEXT_DATA__` article.title                   | `og:title`, `<title>`           | high       | |
 * | summary                | `__NEXT_DATA__` article.description             | `og:description`, `meta[name=description]` | high | |
 * | content_text/html      | `__NEXT_DATA__` article.content (HTML string)   | —                               | high       | "Baca Juga" related-link paragraphs (`p:has(strong.readmore)`) and the client-side reader-pagination marker (`p.page`) stripped before extraction; `<h2>`/`<h3>` subheadings kept. |
 * | author_name            | `__NEXT_DATA__` article.authors[].name (joined) | —                               | medium     | Reporter byline; can legitimately be empty if `authors` is `[]` (not observed live but defensively handled). |
 * | published_at           | `__NEXT_DATA__` article.published_at            | —                               | high       | No-tz `"YYYY-MM-DD HH:MM:SS"` string, assumed Asia/Jakarta local (`+07:00`), same convention as `suara`/`viva`/`tirto`/`cnn_indonesia`. |
 * | updated_at_source      | — (no field exists anywhere for this source)    | —                               | n/a        | Verified live: no `article:modified_time` meta, no modified/updated field on the GraphQL `Article` type. Always `undefined` — genuine coverage gap, not an extraction bug. |
 * | category               | `__NEXT_DATA__` article.category.name           | —                                | high       | |
 * | thumbnail_url          | `__NEXT_DATA__` article.cover                   | `og:image`                       | high       | |
 * | tags                   | `__NEXT_DATA__` article.tags[].name             | —                                | high       | Clean topical `Tag[]` list straight from GraphQL — verified live no taxonomy-label noise the way Tirto's `news_keywords` meta has, so no stopword filtering needed. |
 * | external_article_id    | `__NEXT_DATA__` article.article_id (10-digit)   | URL path segment                | high       | |
 * | language               | Hardcoded `"id"`                                | —                                | high       | Jawa Pos is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump
// independently from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'jawa_pos_v1';

/**
 * The raw adapter's `publishedHint` is the SAME no-tz `"YYYY-MM-DD HH:MM:SS"` string as the
 * authoritative `article.published_at` (both come straight off the GraphQL `Article` node —
 * see `index.js`'s `toDiscoveryEntry()`/`parseWibDateTime()` doc), so this reuses the exact
 * same Asia/Jakarta (+07:00) assumption for consistency between `discovered_urls.
 * published_hint` and the eventual `articles.published_at`.
 * @param {string|undefined} hint
 * @returns {string|undefined} ISO 8601 string, or undefined if unparseable/absent.
 */
function tryParseHint(hint) {
  return rawJawaPos.parseWibDateTime(hint);
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
    canonical_url: { source: 'next_data:article.category.slug+article_id+slug|canonical|og:url', confidence: 'high' },
    title: { source: 'next_data:article.title|og:title|title', confidence: 'high' },
    summary: { source: 'next_data:article.description|og:description|meta:description', confidence: 'high' },
    content_text: { source: 'next_data:article.content_html_stripped', confidence: 'high' },
    author_name: { source: 'next_data:article.authors[].name', confidence: 'medium' },
    published_at: { source: 'next_data:article.published_at', confidence: 'high' },
    updated_at_source: { source: 'unavailable', confidence: 'n/a' },
    category: { source: 'next_data:article.category.name', confidence: 'high' },
    thumbnail_url: { source: 'next_data:article.cover|og:image', confidence: 'high' },
    tags: { source: 'next_data:article.tags[].name', confidence: 'high' },
    external_article_id: { source: 'next_data:article.article_id|url_path_segment', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawJawaPos.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawJawaPos.stripPageParam(draft.url) : undefined,
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
  const raw = rawJawaPos.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['www.jawapos.com', 'jawapos.com'],
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
  return rawJawaPos.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawJawaPos.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawJawaPos.parse(html, ctx);
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
// Wired into `src/adapters/index.js`'s ADAPTER_MODULES map by S4-D as:
//
//   jawa_pos: () => require('./jawa_pos/coreAdapter'),
// ---------------------------------------------------------------------------------
