'use strict';

const rawRepublika = require('./index');

/**
 * Contract-adapter layer for the Republika Online adapter (Sprint 6a, S6a-B) -> crawler core
 * (F3) + db layer (F6). Mirrors `src/adapters/sindonews/coreAdapter.js` / `src/adapters/
 * okezone/coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template`
 * contract (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js`
 * + `src/db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * **ONE `source_id` for the whole multi-subdomain brand** (per task brief, same treatment
 * `detik`/`okezone`/`sindonews` already get in this repo): every `{kanal-or-region}.
 * republika.co.id` vertical (`ekonomi`, `news`, `khazanah`, `rejabar`, `rejogja`, `ameera`,
 * `visual`, `esgnow`, ...) shares this single `source_id: "republika"`, NOT a separate adapter
 * per kanal/region.
 *
 * Registered into `src/adapters/index.js`'s ADAPTER_MODULES map by S6a-D (see the bottom of
 * this file for the registry snippet).
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Republika, and how much we trust
 * it. See `index.js`'s module header for the full live-verification notes this table
 * summarizes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                                  | Confidence | Notes |
 * |------------------------|------------------------------------------------|-------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                        | `og:url`, JSON-LD `mainEntityOfPage.@id`        | high       | `page` query param stripped defensively (no live multipage query markup observed). |
 * | title                  | `NewsArticle` JSON-LD `headline`                | DOM `.max-card__title h1`, `og:title`, `<title>` | high      | |
 * | summary                | `NewsArticle` JSON-LD `description`             | `og:description`, `meta[name=description]`, DOM `.max-card__teaser` | high | |
 * | content_text/html      | DOM `.article-content article`                  | —                                                | high       | Ad/"recreative" widget scaffolding, `.picked-article` ("Baca Juga"), and captions stripped first. |
 * | author_name            | `NewsArticle` JSON-LD `author.name`             | DOM `.max-card__title > div` `"Red:"` name       | medium     | Verified live this is the `"Red:"` (editor) byline, NOT the `"Rep:"` (reporter) byline — never rejected/blocked on that basis. |
 * | published_at           | `NewsArticle` JSON-LD `datePublished` (`+07:00`)| —                                                | high       | |
 * | updated_at_source      | `NewsArticle` JSON-LD `dateModified` (`+07:00`) | —                                                | medium     | Verified live to always equal `datePublished` on sampled articles — Republika does not appear to expose a genuine post-publish edit timestamp today. |
 * | category               | DOM `.breadcrumb a`, last item excluding "Home" | —                                                | high       | No JSON-LD `BreadcrumbList` exists to prefer instead. |
 * | thumbnail_url          | `NewsArticle` JSON-LD `image.url`               | `og:image`                                       | medium–high | JSON-LD `image.url` verified live to sometimes be an empty string; treated as absent. |
 * | tags                   | `meta[name="keywords"]` comma-split             | —                                                | medium     | |
 * | external_article_id    | `{code}` path segment (`/berita/{code}/{slug}`) | —                                                | high       | Tolerant of the live-verified malformed double-slash URL variant (see `index.js`). |
 * | language               | Hardcoded `"id"`                                | —                                                | high       | Republika is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'republika_v1';

/**
 * The raw adapter's `publishedHint` is only reliably an ISO-parseable absolute timestamp when
 * discovery came from the date-scoped `/index/{offset}/{YYYY}/{MM}/{DD}` listing variant
 * (already normalized to ISO 8601 by `rawRepublika.parseListingDate()` inside `index.js`'s
 * listing parser — see that module's header) or from RSS's `pubDate` (a standard RFC 2822
 * string `Date` parses natively). The default `/indeks`/`/index/{offset}` listings carry only
 * a relative Indonesian string ("N menit/jam yang lalu"), which resolves to `undefined` here —
 * the real `published_at` extracted by `parse()` (JSON-LD `datePublished`) remains
 * authoritative regardless.
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
  const metadata = {};
  if (item.normalizedUrl) metadata.normalizedUrlHint = item.normalizedUrl;

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
 * @returns {Object}
 */
function buildFieldProvenance() {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'jsonld:NewsArticle.headline|dom:.max-card__title_h1|og:title|title', confidence: 'high' },
    summary: { source: 'jsonld:NewsArticle.description|og:description|meta:description|dom:.max-card__teaser', confidence: 'high' },
    content_text: { source: 'dom:.article-content_article', confidence: 'high' },
    author_name: {
      source: 'jsonld:NewsArticle.author.name|dom:.max-card__title_Red_byline',
      confidence: 'medium',
      note: 'reflects the "Red:" (editor) byline, not "Rep:" (reporter)',
    },
    published_at: { source: 'jsonld:NewsArticle.datePublished', confidence: 'high' },
    updated_at_source: {
      source: 'jsonld:NewsArticle.dateModified',
      confidence: 'medium',
      note: 'verified live to always equal datePublished on sampled articles',
    },
    category: { source: 'dom:.breadcrumb_a_last_non_home_item', confidence: 'high' },
    thumbnail_url: { source: 'jsonld:NewsArticle.image.url|og:image', confidence: 'medium' },
    tags: { source: 'meta:keywords', confidence: 'medium' },
    external_article_id: { source: 'url_berita_code_segment', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawRepublika.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.canonicalUrl || (draft.url ? rawRepublika.stripPageParam(draft.url) : undefined),
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
    field_provenance: buildFieldProvenance(),
  };
}

/**
 * @returns {import('../../core/types').SourceProfile & {sourceId: string, displayName: string, baseUrl: string, crawlIntervalMinutes: number, overlapHours: number}}
 */
function getSourceProfile() {
  const raw = rawRepublika.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    // Permissive host scope (task brief + `index.js` module header "Multi-subdomain, ONE
    // source_id"): the bare apex + www + ANY other `*.republika.co.id` subdomain, matching
    // `isArticleUrl()`'s own host check. Real-world verified subdomains observed live include
    // (non-exhaustively) ekonomi, news, khazanah, sharia, islamdigest, ameera, visual, esgnow,
    // analisis, en, rejabar, rejogja — kept as a wildcard rather than an exhaustive allowlist
    // since Republika's own kanal/region set already exceeds what a fixed list could future-
    // proof (see `index.js` for the deferred "regional seeds" note).
    allowed_domains: ['republika.co.id', '*.republika.co.id'],
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
  return rawRepublika.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawRepublika.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawRepublika.parse(html, ctx);
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
// Wired into `src/adapters/index.js`'s ADAPTER_MODULES map by S6a-D (source_id "republika"):
//
//   republika: () => require('./republika/coreAdapter'),
// ---------------------------------------------------------------------------------
