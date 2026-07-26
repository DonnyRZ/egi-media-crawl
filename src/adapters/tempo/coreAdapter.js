'use strict';

const rawTempo = require('./index');

/**
 * Contract-adapter layer for the Tempo.co adapter (Sprint 4, S4-A) -> crawler core (F3) + db
 * layer (F6). Mirrors `src/adapters/tirto/coreAdapter.js` / `src/adapters/kumparan/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template` contract
 * (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js` +
 * `src/db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * NOTE: registered in `src/adapters/index.js` by S4-D (see the bottom of this file for the
 * registry snippet that was wired in).
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Tempo, and how much we trust it.
 * Tempo is unusual in this codebase for shipping a full `articleBody` directly inside JSON-LD
 * (every other adapter here has metadata-only JSON-LD) — but the article body is ALSO
 * independently server-rendered into the DOM, which is used as the primary body source since
 * it preserves inline formatting the flattened JSON-LD string does not. See `index.js`'s
 * module header for the full live-verification notes this table summarizes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                                  | Confidence | Notes |
 * |------------------------|------------------------------------------------|-------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                        | `og:url`, JSON-LD `mainEntityOfPage['@id']`     | high       | `page` query param stripped defensively (no live multipage markup observed). |
 * | title                  | JSON-LD `headline`                              | DOM `h1`, `og:title`, `<title>`                 | high       | |
 * | summary                | JSON-LD `description`                           | `og:description`, `meta[name=description]`     | high       | |
 * | content_text/html      | DOM `#content-wrapper p/h2/h3`                  | JSON-LD `articleBody` (`\n`-split)              | high       | Trailing "Pilihan Editor: ..." related-article pick filtered from both sources (verified live present in both). Ad-slot `<div>`s and the "Scroll ke bawah ..." lazy-load-gate paragraph live outside `#content-wrapper` and are excluded by the selector itself, no extra stripping needed. |
 * | author_name            | JSON-LD `author[].name`, deduplicated           | DOM `a[href*="/penulis/"]` (non-empty text)     | medium     | JSON-LD verified live to sometimes list the SAME person twice (once per byline role e.g. reporter+editor) — deduplicated case-insensitively. |
 * | published_at           | JSON-LD `datePublished`                         | `meta[property=article:published_time]` ("DD Bulan YYYY \| HH.MM WIB") | high | Full ISO 8601 with an explicit `+07:00` offset already in JSON-LD — no "assume WIB" guessing needed, same as Kumparan. |
 * | updated_at_source      | JSON-LD `dateModified`                          | —                                                | —          | No `dateModified` (or any other update-timestamp signal) was observed live on ANY sampled article, free or Tempo Plus — always `undefined` for Tempo today. |
 * | category               | Breadcrumb JSON-LD, last non-"Home" item        | —                                                | medium     | e.g. "Bisnis" (sub-rubrik), one level more specific than the URL's own `{rubrik}` segment. |
 * | thumbnail_url          | JSON-LD `image` (bare string)                   | `og:image`                                       | medium–high | |
 * | tags                   | DOM tag-pill widget `a[href^="/tag/"]` (relative-href only) | —                                | medium     | Verified live to match Tempo's own internal `tag_article_new` field exactly; excludes inline contextual `/tag/` links inside the body (those use absolute hrefs instead). Anchor text is the raw kebab-case alias, kept as-is. |
 * | external_article_id    | Trailing numeric id parsed from the URL (`/{rubrik}/{slug}-{id}`) | —                       | high       | |
 * | language               | Hardcoded `"id"`                                | —                                                | high       | Tempo is Indonesian-only. |
 *
 * Tempo Plus / paywall gating: JSON-LD `isAccessibleForFree` (verified live `false` on Tempo
 * Plus/"VIP" articles, where `articleBody`/the DOM body are ALSO independently verified live to
 * be truncated to a short teaser only) is surfaced via `content_text`'s `field_provenance`
 * confidence, which drops to `"low"` whenever `isAccessibleForFree === false` — the extracted
 * `content_text` is then honestly just that short teaser, not a parsing bug. There is no
 * dedicated N5 `ParsedArticle` column for this (see `src/core/types.js`), so it is not invented
 * as a new top-level field.
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump
// independently from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'tempo_v1';

/**
 * The raw adapter's `publishedHint` comes straight from the decoded `_payload.json`
 * `rubric-content.latest.data[].published_at` field (live) or the bundled fixture (offline) —
 * both are `"YYYY-MM-DD HH:MM:SS"` with NO timezone marker (verified live), same "no-tz means
 * WIB" convention CNN Indonesia's `tryParseHint()` already uses for its own listing hints.
 * @param {string|undefined} hint
 * @returns {string|undefined} ISO 8601 string, or undefined if unparseable/absent.
 */
function tryParseHint(hint) {
  if (!hint) return undefined;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(hint);
  const normalized = hasTz ? hint : `${hint.replace(' ', 'T')}+07:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {import('./index').DiscoveredItem} item - raw adapter shape (camelCase).
 * @returns {import('../../core/types').DiscoveryItem} core shape (snake_case).
 */
function toCoreDiscoveryItem(item) {
  const metadata = {};
  if (item.normalizedUrl) metadata.normalizedUrlHint = item.normalizedUrl;
  // Access-level hint ("FREE"/"VIP"/"FREEMIUM", verified live all three appear in a single real
  // rubrik listing — see index.js module header) carried through for observability/future
  // paywall-aware scheduling; not part of the N5 ParsedArticle contract itself.
  if (item.accessHint) metadata.accessHint = item.accessHint;

  return {
    url: item.rawUrl,
    channel: item.discoveryChannel || 'unknown',
    external_id: item.externalId,
    title_hint: item.listingTitle,
    published_hint: tryParseHint(item.publishedHint),
    category_hint: item.categoryHint,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/**
 * Builds the `field_provenance` JSONB payload documented in the field matrix above.
 * @param {ReturnType<typeof rawTempo.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(draft) {
  const isPaywalled = draft && draft.isAccessibleForFree === false;
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'jsonld:headline|dom:h1|og:title|title', confidence: 'high' },
    summary: { source: 'jsonld:description|og:description|meta:description', confidence: 'high' },
    content_text: {
      source: 'dom:#content-wrapper_p_h2_h3|jsonld:articleBody',
      confidence: isPaywalled ? 'low' : 'high',
      note: isPaywalled ? 'jsonld:isAccessibleForFree=false (Tempo Plus) — content_text is a short teaser only' : undefined,
    },
    author_name: { source: 'jsonld:author[].name_deduped|dom:a[href*=/penulis/]', confidence: 'medium' },
    published_at: { source: 'jsonld:datePublished|meta:article:published_time', confidence: 'high' },
    updated_at_source: { source: 'jsonld:dateModified', confidence: 'medium' },
    category: { source: 'jsonld:breadcrumb_last_non_home_item', confidence: 'medium' },
    thumbnail_url: { source: 'jsonld:image|og:image', confidence: 'medium' },
    tags: { source: 'dom:a[href^=/tag/]_widget', confidence: 'medium' },
    external_article_id: { source: 'url_trailing_numeric_id', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawTempo.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawTempo.stripPageParam(draft.url) : undefined,
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
  const raw = rawTempo.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['tempo.co', 'www.tempo.co'],
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
  return rawTempo.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawTempo.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawTempo.parse(html, ctx);
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
//   tempo: () => require('./tempo/coreAdapter'),
// ---------------------------------------------------------------------------------
