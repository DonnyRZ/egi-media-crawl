'use strict';

const rawKumparan = require('./index');

/**
 * Contract-adapter layer for the Kumparan adapter (Sprint 4, S4-B) -> crawler core (F3) + db
 * layer (F6). Mirrors `src/adapters/tirto/coreAdapter.js` / `src/adapters/cnn_indonesia/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template` contract
 * (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js` +
 * `src/db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * NOTE: registered in `src/adapters/index.js` by S4-D (see the bottom of this file for the
 * registry snippet that was wired in).
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Kumparan, and how much we trust
 * it. Kumparan is JSON-LD-first (verified live 2026-07-24): a `NewsArticle` block covers most
 * fields with full ISO 8601 UTC timestamps (no "assume WIB" guessing needed, unlike suara/
 * viva/tirto), plus a separate `BreadcrumbList` block for category. Body text and tags have no
 * JSON-LD equivalent and come from stable `data-qa-id` DOM hooks instead. See `index.js`'s
 * module header for the full live-verification notes this table summarizes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                                  | Confidence | Notes |
 * |------------------------|------------------------------------------------|-------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                        | `og:url`, JSON-LD `mainEntityOfPage['@id']`     | high       | `page` query param stripped defensively (no live multipage markup observed). |
 * | title                  | JSON-LD `headline`                              | DOM `[data-qa-id=story-title]`, `og:title`, `<title>` | high | |
 * | summary                | `meta[name=description]`                        | JSON-LD `description`, `og:description` (hashtags stripped) | high | `og:description` verified live to append a `#newsupdate ...` hashtag block that `meta[name=description]` never has — stripped before use as a fallback. |
 * | content_text/html      | DOM `p[data-qa-id="story-paragraph"]`           | —                                                | high       | No JSON-LD `articleBody`. Selector is scoped directly to the qa-id (not a container walk), so ad `<aside>`s / image `<figcaption>`s (verified live as siblings, never nested) are excluded with no extra stripping needed. |
 * | author_name            | JSON-LD `author.name`                           | DOM `[data-qa-id="author-name"]`                | medium     | JSON-LD carries the REAL individual byline (e.g. "zamachsyari chawarazmi"); the DOM fallback is actually the publishing ACCOUNT name (e.g. "kumparanNEWS") — kept as fallback only since it's still attributable, same "brand-only OK" stance as CNN Indonesia. |
 * | published_at           | JSON-LD `datePublished`                         | DOM `[data-qa-id="publish-date"]` ("DD Bulan YYYY HH:mm WIB") | high | Full ISO 8601 with explicit UTC offset in JSON-LD — the DOM fallback is Indonesian-month-name parsed defensively, only used if JSON-LD is absent. |
 * | updated_at_source      | JSON-LD `dateModified`                          | —                                                | high       | Same full-ISO-with-offset shape as `datePublished`. |
 * | category               | Breadcrumb JSON-LD, channel item (3rd-from-last)| —                                                | medium     | e.g. "News". No URL-segment fallback exists: Kumparan article URLs are flat (`/{account}/{slug}-{id}`), with no `{channel}` segment to fall back to — same structural gap as Tirto. |
 * | thumbnail_url          | JSON-LD `image[0]`                              | `og:image`                                       | medium–high | |
 * | tags                   | DOM footer `a[data-qa-id=tag-topic] span[data-qa-id=label-tag-topic]` | de-duplicated `meta[name=keywords]`/`news_keywords` | medium | Footer topic list is purpose-built and clean; the meta fallback is verified-live SEO keyword-stuffing (each real keyword repeated as "Berita Terkini X"/"Berita Terbaru X"/"Berita Hari Ini X") and only used if the footer list is empty. |
 * | external_article_id    | Trailing 11-char shortId parsed from the URL (`/{account}/{slug}-{shortId}`) | — | high | Verified live across multiple samples: always exactly 11 chars, always starting with 2 digits. |
 * | language               | Hardcoded `"id"`                                | —                                                | high       | Kumparan is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump
// independently from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'kumparan_v1';

/**
 * The raw adapter's `publishedHint` comes straight from the GraphQL content feed's
 * `publishedAt` field (live) or the bundled fixture (offline) — both are expected to already
 * be full ISO 8601 strings (see `index.js`'s `mapContentFeedResponseToItems()`), unlike
 * Tirto/CNN Indonesia's unparseable relative-time listing hints. Still passed through
 * `tryParseHint()` defensively in case a future live response ever supplies a non-ISO string.
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
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'jsonld:headline|dom:story-title|og:title|title', confidence: 'high' },
    summary: { source: 'meta:description|jsonld:description|og:description_hashtags_stripped', confidence: 'high' },
    content_text: { source: 'dom:p[data-qa-id=story-paragraph]', confidence: 'high' },
    author_name: { source: 'jsonld:author.name|dom:author-name', confidence: 'medium' },
    published_at: { source: 'jsonld:datePublished|dom:publish-date', confidence: 'high' },
    updated_at_source: { source: 'jsonld:dateModified', confidence: 'high' },
    category: { source: 'jsonld:breadcrumb_channel_item', confidence: 'medium' },
    thumbnail_url: { source: 'jsonld:image[0]|og:image', confidence: 'medium' },
    tags: { source: 'dom:tag-topic_footer|meta:keywords_deduped', confidence: 'medium' },
    external_article_id: { source: 'url_trailing_11char_shortid', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawKumparan.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawKumparan.stripPageParam(draft.url) : undefined,
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
  const raw = rawKumparan.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['kumparan.com'],
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
  return rawKumparan.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawKumparan.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawKumparan.parse(html, ctx);
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
//   kumparan: () => require('./kumparan/coreAdapter'),
// ---------------------------------------------------------------------------------
