'use strict';

const rawOkezone = require('./index');

/**
 * Contract-adapter layer for the Okezone adapter (Sprint 5, S5-A) -> crawler core (F3) + db
 * layer (F6). Mirrors `src/adapters/detik/coreAdapter.js` / `src/adapters/tempo/coreAdapter.js`
 * / `src/adapters/jawa_pos/coreAdapter.js`'s bridge pattern exactly: `./index.js` implements
 * the `_template` contract (camelCase); this module maps that to the snake_case shape
 * `src/core/pipeline.js` + `src/db/**` expect (see `src/core/types.js`), and back-fills
 * `sourceId`/`displayName`/... camelCase aliases onto the profile object for
 * `src/sources/registry.js`.
 *
 * **ONE `source_id` for the whole multi-subdomain brand** (per task brief): every
 * `{kanal}.okezone.com` vertical (`news`, `bola`, `economy`, `women`, `sports`, `celebrity`,
 * `ototekno`, `muslim`, `edukasi`) shares this single `source_id: "okezone"` — same treatment
 * `detik/coreAdapter.js` gives every `*.detik.com` vertical, NOT a separate adapter per kanal.
 *
 * Registered in `src/adapters/index.js`'s ADAPTER_MODULES map by S5-D (see the bottom of
 * this file for the registry snippet that was wired in).
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Okezone, and how much we trust it.
 * See `index.js`'s module header for the full live-verification notes this table summarizes.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                                  | Confidence | Notes |
 * |------------------------|------------------------------------------------|-------------------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                        | `og:url`, `WebPage` JSON-LD `url`               | high       | `page` query param (`?page=2`/`?page=all`) always stripped before storing. |
 * | title                  | `NewsArticle` JSON-LD `headline`                | DOM `.title-article h1`, `og:title`, `<title>`  | high       | |
 * | summary                | `NewsArticle` JSON-LD `description`             | `og:description`, `meta[name=description]`     | high       | |
 * | content_text/html      | DOM `.c-detail.read` (merged via `?page=all` when multipage) | — | high | `#baca-juga`/`.vicon`/page-break-marker noise stripped first; see `pages_detected`/`merged_via_page_all` in `field_provenance` below. |
 * | author_name            | `NewsArticle` JSON-LD `author.name`             | DOM `.journalist a[href*=redaksi.okezone.com]`  | medium     | |
 * | published_at           | `NewsArticle` JSON-LD `datePublished` (`+07:00`)| `meta[itemprop=datePublished]`                  | high       | |
 * | updated_at_source      | `NewsArticle` JSON-LD `dateModified`            | —                                                | medium     | Verified live to carry NO timezone (`"2026-07-24 15:16:40"`) — assumed WIB (`+07:00`). |
 * | category               | `BreadcrumbList` JSON-LD, last non-"Home" item  | —                                                | high       | Correctly-cased (e.g. "Nasional"); the DOM breadcrumb itself is all-caps. |
 * | thumbnail_url          | `NewsArticle` JSON-LD `image.url`               | `og:image`                                       | medium–high | |
 * | tags                   | DOM `#tag .box-tag a` text list                 | —                                                | medium     | |
 * | external_article_id    | `{articleId}` path segment (`/read/.../{id}/{slug}`) | —                                          | high       | Stable across kanal/subdomain (verified live to match JSON-LD `mainEntityOfPage["@id"]`). |
 * | language               | Hardcoded `"id"`                                | —                                                | high       | Okezone is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'okezone_v1';

/**
 * Discovery listing timestamps are already parsed to ISO 8601 (or `undefined`) by
 * `rawOkezone.parseIndonesianDateTime()` inside `index.js`'s listing parsers — this is a thin
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
 * @param {ReturnType<typeof rawOkezone.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(draft) {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|jsonld:WebPage.url', confidence: 'high' },
    title: { source: 'jsonld:NewsArticle.headline|dom:.title-article_h1|og:title|title', confidence: 'high' },
    summary: { source: 'jsonld:NewsArticle.description|og:description|meta:description', confidence: 'high' },
    content_text: {
      source: 'dom:.c-detail.read (baca_juga/vicon/page-break noise stripped)',
      confidence: 'high',
      pages_detected: draft.pagesDetected || 1,
      merged_via_page_all: Boolean(draft.mergedViaPageAll),
    },
    author_name: { source: 'jsonld:NewsArticle.author.name|dom:.journalist_a[href*=redaksi.okezone.com]', confidence: 'medium' },
    published_at: { source: 'jsonld:NewsArticle.datePublished|meta:itemprop=datePublished', confidence: 'high' },
    updated_at_source: {
      source: 'jsonld:NewsArticle.dateModified',
      confidence: 'medium',
      note: 'no-tz value, assumed +07:00 (WIB)',
    },
    category: { source: 'jsonld:BreadcrumbList_last_non_home_item', confidence: 'high' },
    thumbnail_url: { source: 'jsonld:NewsArticle.image.url|og:image', confidence: 'medium' },
    tags: { source: 'dom:#tag_.box-tag_a', confidence: 'medium' },
    external_article_id: { source: 'url_path_article_id_segment', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawOkezone.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawOkezone.stripPageParam(draft.url) : undefined,
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
    field_provenance: buildFieldProvenance(draft),
  };
}

/**
 * @returns {import('../../core/types').SourceProfile & {sourceId: string, displayName: string, baseUrl: string, crawlIntervalMinutes: number, overlapHours: number}}
 */
function getSourceProfile() {
  const raw = rawOkezone.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    // Explicit allowlist (task brief: NOT `*.okezone.com`) — every live-verified news-kanal
    // host, plus the discovery-only `index.okezone.com` cross-channel host. See
    // `index.js`'s `ALLOWED_ARTICLE_HOSTS`/`DISCOVERY_HOST`/module header for the live
    // verification notes on why a blind wildcard would wrongly admit `mpi.okezone.com`
    // (republishes SINDOnews content) and sibling MNC Media brands off the `okezone.com`
    // apex entirely (e.g. `inews.id`).
    allowed_domains: [...rawOkezone.ALLOWED_ARTICLE_HOSTS, rawOkezone.DISCOVERY_HOST],
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
  return rawOkezone.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawOkezone.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawOkezone.parse(html, ctx);
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
// Wired into `src/adapters/index.js`'s ADAPTER_MODULES map by S5-D:
//
//   okezone: () => require('./okezone/coreAdapter'),
// ---------------------------------------------------------------------------------
