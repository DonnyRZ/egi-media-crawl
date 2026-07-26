'use strict';

const rawMediaIndonesia = require('./index');

/**
 * Contract-adapter layer for the Media Indonesia adapter (Sprint 6a, S6a-C) -> crawler core
 * (F3) + db layer (F6). Mirrors `src/adapters/tirto/coreAdapter.js` / `src/adapters/tempo/
 * coreAdapter.js` / `src/adapters/okezone/coreAdapter.js`'s bridge pattern exactly: `./index.js`
 * implements the `_template` contract (camelCase); this module maps that to the snake_case
 * shape `src/core/pipeline.js` + `src/db/**` expect (see `src/core/types.js`), and back-fills
 * `sourceId`/`displayName`/... camelCase aliases onto the profile object for
 * `src/sources/registry.js`.
 *
 * Registered into `src/adapters/index.js`'s ADAPTER_MODULES map by S6a-D (see the bottom of
 * this file for the registry snippet); S6a-D also added this adapter's fixture entry to
 * `src/workers/lib/fetchHtml.js`'s FIXTURE_PATHS map.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Media Indonesia, and how much we
 * trust it. See `index.js`'s module header for the full assessment notes this table
 * summarizes, including the explicit caveat that this assessment's fetch tooling could not
 * independently confirm exact DOM class names via raw HTML (unlike most sibling adapters) —
 * meta/Open Graph tags are therefore treated as PRIMARY wherever standard, with DOM selectors
 * as secondary/fallback enhancements.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                          | Confidence | Notes |
 * |------------------------|------------------------------------------------|----------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                        | `og:url`                               | high       | `page` query param stripped defensively (brief: `?page=`/`/page/N` are ineffective here anyway). |
 * | title                  | `og:title`                                      | DOM `<h1>`, `<title>`                  | high       | |
 * | summary                | `meta[name=description]`                        | `og:description`                       | medium     | Teaser/SEO text; optional under N5. |
 * | content_text/html      | DOM `div.article` (per task brief)              | —                                       | high (low when premium/teaser-flagged) | "Baca juga"/follow-CTA/ad noise stripped before extraction; see `isPremiumOrTeaser` note below. |
 * | author_name            | DOM `.byline .author` / `.date-author .author`  | `meta:article:author`, `meta:author`   | medium     | Best-effort DOM selector (see index.js header caveat); sometimes brand/institutional on PR-style pieces, never blocked on that basis, same stance as CNN Indonesia/Tirto. |
 * | published_at           | `meta[property=article:published_time]`         | DOM byline date ("D/M/YYYY HH:mm", assumed WIB) | medium | Meta tag presence assumed from standard Open Graph Article convention, not independently confirmed live for MI specifically (see index.js header). |
 * | updated_at_source      | `meta[property=article:modified_time]`          | —                                       | medium     | No-tz value assumed WIB, same convention as every sibling adapter; live presence unconfirmed (defensive, costs nothing when absent). |
 * | category               | DOM breadcrumb `.breadcrumb a` (last non-Home)  | `{kanal}` URL segment                  | medium     | URL-segment fallback IS verified live (e.g. "jelita", "ekonomi"). |
 * | thumbnail_url          | `og:image`                                      | —                                       | medium–high | |
 * | tags                   | DOM tag-pill widget (`.tag-list a`/`.tags a`)   | —                                       | medium     | Leading "#" marker (verified live in rendered tag text) stripped. |
 * | external_article_id    | Numeric `{numericId}` segment parsed from the URL (`/{kanal}/{numericId}/{slug}`) | — | high | Verified live URL shape. |
 * | language               | Hardcoded `"id"`                                | —                                       | high       | Media Indonesia is Indonesian-only. |
 *
 * **Premium/teaser confidence drop**: `content_text`'s `field_provenance` confidence drops to
 * `"low"` (with an explanatory note) whenever the raw adapter's `isPremiumOrTeaser` heuristic
 * fires (marker element/CTA text/suspiciously-short body — see `index.js`'s
 * `detectPremiumOrTeaser()` doc). This mirrors Tempo's `isAccessibleForFree` confidence-drop
 * pattern exactly, per the task brief's own peer-reference instruction — the extracted
 * `content_text` in that case is documented as a likely teaser, never padded/faked to look like
 * a full body.
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'media_indonesia_v1';

/**
 * The raw adapter's `publishedHint` is already resolved to ISO 8601 (or `undefined`) by
 * `rawMediaIndonesia.parseDateTimeSlash()` / `toIsoOrUndefined()` inside `index.js`'s own
 * listing/sitemap parsers — this is a thin pass-through kept for symmetry with every sibling
 * coreAdapter's own `tryParseHint()`, and as a defensive re-validation in case a future raw
 * parser change starts returning raw strings.
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
 * @param {ReturnType<typeof rawMediaIndonesia.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(draft) {
  const isPremiumOrTeaser = Boolean(draft && draft.isPremiumOrTeaser);
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url', confidence: 'high' },
    title: { source: 'og:title|dom:h1|title', confidence: 'high' },
    summary: { source: 'meta:description|og:description', confidence: 'medium' },
    content_text: {
      source: 'dom:div.article',
      confidence: isPremiumOrTeaser ? 'low' : 'high',
      note: isPremiumOrTeaser
        ? 'premium/teaser heuristic fired (marker element, paywall CTA text, or suspiciously short body) — content_text may be a short teaser only, not a parsing bug'
        : undefined,
    },
    author_name: { source: 'dom:.byline_.author|dom:.date-author_.author|meta:article:author|meta:author', confidence: 'medium' },
    published_at: { source: 'meta:article:published_time|dom:byline_date', confidence: 'medium' },
    updated_at_source: { source: 'meta:article:modified_time', confidence: 'medium' },
    category: { source: 'dom:.breadcrumb_a_last_non_home|url_kanal_segment', confidence: 'medium' },
    thumbnail_url: { source: 'og:image', confidence: 'medium' },
    tags: { source: 'dom:.tag-list_a', confidence: 'medium' },
    external_article_id: { source: 'url_path_numeric_id_segment', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawMediaIndonesia.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawMediaIndonesia.stripPageParam(draft.url) : undefined,
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
  const raw = rawMediaIndonesia.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['mediaindonesia.com', 'www.mediaindonesia.com'],
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
  return rawMediaIndonesia.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawMediaIndonesia.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawMediaIndonesia.parse(html, ctx);
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
// Wired into `src/adapters/index.js`'s ADAPTER_MODULES map by S6a-D (source_id
// "media_indonesia"), which also added this source's `sample-article.html` entry to
// `src/workers/lib/fetchHtml.js`'s FIXTURE_PATHS map:
//
//   media_indonesia: () => require('./media_indonesia/coreAdapter'),
// ---------------------------------------------------------------------------------
