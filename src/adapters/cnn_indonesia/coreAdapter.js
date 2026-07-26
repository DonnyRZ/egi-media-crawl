'use strict';

const rawCnnIndonesia = require('./index');

/**
 * Contract-adapter layer for the CNN Indonesia adapter (Sprint 3, S3-A) -> crawler core (F3)
 * + db layer (F6). Mirrors `src/adapters/detik/coreAdapter.js` / `src/adapters/suara/
 * coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template` contract
 * (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js` + `src/
 * db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * NOTE: this module is intentionally NOT registered in `src/adapters/index.js` yet — that is
 * owned by S3-D. See the bottom of this file's header for the exact registry snippet.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for CNN Indonesia, and how much we
 * trust it. "Hybrid" sources merge JSON-LD (`NewsArticle`, no `articleBody`) with the DOM
 * (`.detail-text`), per the assessment notes. CNN Indonesia shares its underlying CMS
 * template with Detik (same `connect.detik.com` auth stack, same `akcdn.detik.net.id` image
 * CDN), so several selectors below intentionally mirror `detik/coreAdapter.js`'s matrix.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                          | Fallback(s)                          | Confidence | Notes |
 * |------------------------|------------------------------------------|----------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                 | `og:url`, JSON-LD `mainEntityOfPage.@id` | high     | `page` query param always stripped defensively (no live multipage markup observed, see `index.js` header). |
 * | title                  | JSON-LD `NewsArticle.headline`           | DOM `<h1>`, `og:title`, `<title>`      | high       | |
 * | summary                | JSON-LD `description`                    | `og:description`, `meta[name=description]` | medium | Teaser/SEO text; optional under N5. |
 * | content_text/html      | DOM `.detail-text`                       | —                                       | high       | `.linksisip` ("Lihat Juga"), `.paradetail` (parallax/scroll ads), `div-gpt-ad` slots, `.newstag`, the "preferred source on Google" widget, and a trailing desk sign-off `<strong>` are stripped before extraction. |
 * | author_name            | JSON-LD `author.name`                    | DOM `.text-cnn_black_light3 span` byline | low     | Verified live 2026-07-24 that `author.name` is frequently `""`; the DOM byline is usually just the outlet name ("CNN Indonesia") too — assessment notes flag this as "Author often brand — optional weak OK", never blocking. |
 * | published_at           | JSON-LD `datePublished`                  | —                                       | high       | DOM date div is a human string ("Jumat, 24 Jul 2026 10:47 WIB"), not used — JSON-LD carries a real ISO offset. |
 * | updated_at_source      | JSON-LD `dateModified`                   | —                                       | medium     | |
 * | category               | Breadcrumb DOM `a.gtm_breadcrumb_kanal`  | `{kanal}` URL segment                  | medium     | |
 * | thumbnail_url          | JSON-LD `image`/`image.url`              | `og:image`                              | medium–high | |
 * | tags                   | "TOPIK TERKAIT" `<aside>` link text      | —                                       | medium     | Deliberately NOT the inline `/tag/` keyword-highlight links inside `.detail-text` (see `index.js` `extractTags` doc). |
 * | external_article_id    | Numeric `articleId` segment parsed from the URL (`/{kanal}/{14digits}-{kanalId}-{articleId}/{slug}`) | — | high | |
 * | language               | Hardcoded `"id"`                         | —                                       | high       | CNN Indonesia is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump
// independently from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'cnn_indonesia_v1';

/**
 * The raw adapter's `publishedHint` is the absolute timestamp string pulled out of the
 * listing's HTML comment (e.g. "2026-07-24 10:48:53" — see `index.js`'s `extractIndeksItems`
 * doc), assumed Asia/Jakarta local time since it carries no timezone offset itself.
 * `discovered_urls.published_hint` is TIMESTAMPTZ, so we only keep it when it actually
 * parses; the real `published_at` extracted by `parse()` (JSON-LD `datePublished`, which does
 * carry a `+07:00` offset) remains authoritative either way.
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
    canonical_url: { source: 'link[rel=canonical]|og:url|json_ld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'json_ld:headline|dom:h1|og:title', confidence: 'high' },
    summary: { source: 'json_ld:description|og:description|meta:description', confidence: 'medium' },
    content_text: { source: 'dom:.detail-text', confidence: 'high' },
    author_name: { source: 'json_ld:author.name|dom:.text-cnn_black_light3', confidence: 'low' },
    published_at: { source: 'json_ld:datePublished', confidence: 'high' },
    updated_at_source: { source: 'json_ld:dateModified', confidence: 'medium' },
    category: { source: 'dom:breadcrumb.gtm_breadcrumb_kanal|url_kanal_segment', confidence: 'medium' },
    thumbnail_url: { source: 'json_ld:image.url|og:image', confidence: 'medium' },
    tags: { source: 'dom:aside[topik_terkait]', confidence: 'medium' },
    external_article_id: { source: 'url_path_article_id', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawCnnIndonesia.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawCnnIndonesia.stripPageParam(draft.url) : undefined,
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
  const raw = rawCnnIndonesia.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['www.cnnindonesia.com'],
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
  return rawCnnIndonesia.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawCnnIndonesia.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawCnnIndonesia.parse(html, ctx);
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
// READY FOR S3-D — registry snippet for `src/adapters/index.js`'s ADAPTER_MODULES map
// (source_id "cnn_indonesia", NOT yet wired in on purpose — this adapter owns only its own
// folder, per Sprint 3 exclusive-ownership rules):
//
//   cnn_indonesia: () => require('./cnn_indonesia/coreAdapter'),
// ---------------------------------------------------------------------------------
