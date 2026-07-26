'use strict';

const rawSindonews = require('./index');
const { parseListingDateIso } = require('../../core/parseListingDate');

/**
 * Contract-adapter layer for the SINDOnews adapter (Sprint 5, S5-B) -> crawler core (F3) + db
 * layer (F6). Mirrors `src/adapters/viva/coreAdapter.js` / `src/adapters/tirto/coreAdapter.js`'s
 * bridge pattern exactly: `./index.js` implements the `_template` contract (camelCase); this
 * module maps that to the snake_case shape `src/core/pipeline.js` + `src/db/**` expect (see
 * `src/core/types.js`), and back-fills `sourceId`/`displayName`/... camelCase aliases onto the
 * profile object for `src/sources/registry.js`.
 *
 * Registered in `src/adapters/index.js`'s ADAPTER_MODULES map by S5-D (this file does not
 * touch that file, per the Sprint 5 exclusive-ownership rules). See the bottom of this file
 * for the registry snippet that was wired in.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for SINDOnews, and how much we trust
 * it. Hybrid source: JSON-LD `NewsArticle` (+ a separate `BreadcrumbList` block for category)
 * carries most metadata; the body itself has no JSON-LD `articleBody` and no `<p>` markup, so
 * it is extracted from the DOM with a custom `<br>`-run paragraph splitter (see `index.js`
 * module header "Body markup has NO <p> tags").
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                              | Fallback(s)                    | Confidence | Notes |
 * |------------------------|------------------------------------------------|----------------------------------|------------|-------|
 * | canonical_url          | `link[rel=canonical]`                           | `og:url`, JSON-LD `mainEntityOfPage['@id']` | high | Always the bare page-1 URL live — never the `/5`-suffixed pagination path or `?showpage=all` (verified on page 1, page 2, AND `?showpage=all` itself). Pagination path segment + any query stripped defensively either way (see `stripPageParam()`). |
 * | title                  | JSON-LD `headline`                              | DOM `h1.detail-title`, `og:title`, `<title>` | high | |
 * | summary                | JSON-LD `description`                           | `og:description`, `meta[name=description]` | high | |
 * | content_text/html      | DOM `.detail-desc`/`#detail-desc`, `<br>`-run split, merged from `?showpage=all` when reachable | page-1-only body if the extra fetch fails | high | **Multipage prefers `?showpage=all`** per task brief — see `index.js` "CRITICAL" note. "Baca Juga" inline recirculation prompts + embedded-video widgets (`[class^="v-"]`) + trailing desk-initials sign-off (`.editor`) stripped before extraction. |
 * | author_name            | JSON-LD `author.name`                           | DOM `.detail-nama-redaksi a[rel="author"]` | medium | |
 * | published_at           | JSON-LD `datePublished`                         | DOM `.detail-date-artikel` ("Jum'at, DD Month YYYY - HH:mm WIB") | high | JSON-LD carries an explicit `+07:00` offset live, so no naive-timezone guessing is normally needed; the DOM fallback still assumes `WIB` => `+07:00` for parity with every other "no-tz means WIB" adapter in this repo. |
 * | updated_at_source      | JSON-LD `dateModified`                          | —                                | medium     | |
 * | category               | JSON-LD `BreadcrumbList`, last (most specific) item | kanal subdomain label (discovery-time hint only, not set on the parsed article) | high | Verified live SINDOnews breadcrumbs are always exactly 2 items ("home" + one category), so "last" is unambiguous. |
 * | thumbnail_url          | JSON-LD `image.url`                             | `og:image`                       | high       | |
 * | tags                   | `meta[name="keywords"]` (comma-split)            | —                                 | medium     | Verified live populated with real topical keywords, no taxonomy-label noise observed (unlike tirto's `news_keywords` gap). |
 * | external_article_id    | FIRST numeric segment after `/read/` in the URL | —                                 | high       | **Primary dedupe key across kanal/subdomains** per task brief — same id regardless of which `{kanal}.sindonews.com` host served the URL, and immune to the `/5`,`/10` pagination-suffix misparse trap (see `index.js` module header). |
 * | language               | Hardcoded `"id"`                                | —                                 | high       | SINDOnews is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump independently
// from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'sindonews_v1';

/**
 * The raw adapter's `publishedHint` is a non-ISO Indonesian listing date string (e.g.
 * "Jum'at, 24 Juli 2026 - 15:22 WIB"). Parsed via shared `parseListingDateIso` so
 * `discovered_urls.published_hint` matches overlap-stop parsing.
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
 * @param {ReturnType<typeof rawSindonews.parse>} draft
 * @returns {Object}
 */
function buildFieldProvenance(draft) {
  return {
    canonical_url: { source: 'link[rel=canonical]|og:url|json_ld:mainEntityOfPage', confidence: 'high' },
    title: { source: 'json_ld:headline|dom:h1.detail-title|og:title|title', confidence: 'high' },
    summary: { source: 'json_ld:description|og:description|meta:description', confidence: 'high' },
    content_text: {
      source: 'dom:.detail-desc_br_run_split',
      confidence: 'high',
      used_showpage_all: Boolean(draft && draft.usedShowpageAll),
    },
    author_name: { source: 'json_ld:author.name|dom:.detail-nama-redaksi_a[rel=author]', confidence: 'medium' },
    published_at: { source: 'json_ld:datePublished|dom:.detail-date-artikel', confidence: 'high' },
    updated_at_source: { source: 'json_ld:dateModified', confidence: 'medium' },
    category: { source: 'json_ld:breadcrumb_last_item', confidence: 'high' },
    thumbnail_url: { source: 'json_ld:image.url|og:image', confidence: 'high' },
    tags: { source: 'meta:keywords', confidence: 'medium' },
    external_article_id: { source: 'url_first_numeric_segment_after_read', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawSindonews.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.canonicalUrl || draft.url || undefined,
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
  const raw = rawSindonews.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    // Multi-subdomain allowlist (one source_id for the whole brand — see index.js module
    // header): every verified kanal host + the bare `www` host, EXCLUDING asset/CDN hosts
    // (`e.`/`pict.`) and out-of-scope MNC-group products (`hi-lite.`/`scope.`/`media.`).
    allowed_domains: Array.from(rawSindonews.ALLOWED_ARTICLE_HOSTS),
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
  return rawSindonews.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawSindonews.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawSindonews.parse(html, ctx);
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
//   sindonews: () => require('./sindonews/coreAdapter'),
// ---------------------------------------------------------------------------------
