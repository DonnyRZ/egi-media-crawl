'use strict';

const rawTirto = require('./index');

/**
 * Contract-adapter layer for the Tirto.id adapter (Sprint 3, S3b) -> crawler core (F3) + db
 * layer (F6). Mirrors `src/adapters/cnn_indonesia/coreAdapter.js` / `src/adapters/
 * liputan6/coreAdapter.js`'s bridge pattern exactly: `./index.js` implements the `_template`
 * contract (camelCase); this module maps that to the snake_case shape `src/core/pipeline.js`
 * + `src/db/**` expect (see `src/core/types.js`), and back-fills `sourceId`/`displayName`/...
 * camelCase aliases onto the profile object for `src/sources/registry.js`.
 *
 * NOTE: registered in `src/adapters/index.js` by S3b-D. See the bottom of this file for
 * the registry snippet that was wired in.
 *
 * ---------------------------------------------------------------------------------
 * Field matrix — how each ParsedArticle field is sourced for Tirto, and how much we trust
 * it. Unlike detik/CNN Indonesia/Liputan6, Tirto ships NO `NewsArticle` (or any `Article`)
 * JSON-LD block at all (verified live 2026-07-24 across multiple samples — only
 * `BreadcrumbList` + `Organization`), so every field below is Open-Graph/meta + DOM only.
 * ---------------------------------------------------------------------------------
 *
 * | ParsedArticle field   | Primary source                          | Fallback(s)                          | Confidence | Notes |
 * |------------------------|------------------------------------------|----------------------------------------|------------|-------|
 * | canonical_url          | `<link rel="canonical">`                 | `og:url`                               | high       | `page` query param stripped defensively (no live multipage markup observed, see `index.js` header). |
 * | title                  | DOM `h1.article-title`                   | `og:title`, `<title>`                  | high       | |
 * | summary                | `og:description`                         | `meta[name=description]`, DOM `p.kicker` | high     | All three were identical live; `p.kicker` kept as a last-resort DOM fallback. |
 * | content_text/html      | DOM `.content-text-editor`               | —                                       | high       | `script`/`style` (ad snippets), `ins[data-revive-*]`, `[id^="gpt-"]` ad slots, `.baca-holder` ("Baca juga" lists), and `figcaption` (photo credits) stripped before extraction; in-body `<h2>` subheadings are kept. |
 * | author_name            | `meta[property="article:author"]`        | DOM `.byline a.reporter-name`          | medium     | Sometimes institutional (e.g. "Tim Riset Tirto" on fact-check pieces) — never rejected/blocked on that basis, same stance as CNN Indonesia's brand-only byline. |
 * | published_at           | DOM `.byline div` "Terbit DD Mon YYYY HH:mm WIB" | —                              | high       | Primary/authoritative — verified live it can predate `updated_at_source` by weeks (a genuine post-publish edit), so the two are never conflated. |
 * | updated_at_source      | `meta[property="article:modified_time"]` | —                                       | medium     | No-tz `"YYYY-MM-DD HH:MM:SS"` string, assumed Asia/Jakarta local (`+07:00`), same convention as `suara`/`viva`. |
 * | category               | Breadcrumb DOM `.breadcrumbs-wrapper a`  | —                                       | medium     | Last/most-specific label (e.g. "Ekonomi", "News Plus"). No URL-segment fallback exists: Tirto article URLs are flat, with no `{channel}` path segment to fall back to. |
 * | thumbnail_url          | `og:image`                               | —                                       | medium–high | |
 * | tags                   | `meta[name="news_keywords"]` (comma-split), filtered against breadcrumb labels + a small stopword list | — | low–medium | Verified live this field mixes real topical keywords with the article's own restated channel/taxonomy labels (see `index.js` `extractTags()` doc) — filtered heuristically, same tag-gap caveat Liputan6's `meta:keywords` approach already carries. |
 * | external_article_id    | Trailing 4-character code parsed from the URL (`/{slug-words}-{code}`) | — | high | |
 * | language               | Hardcoded `"id"`                         | —                                       | high       | Tirto is Indonesian-only. |
 *
 * `field_provenance` (N5 contract, `articles.field_provenance` JSONB) is populated from this
 * same matrix in `buildFieldProvenance()` below, keyed by snake_case field name.
 */

// Stored on every article row (articles.adapter_version / parser_version); bump
// independently from the raw adapter's internal version if its parsing logic changes.
const ADAPTER_VERSION = 'tirto_v1';

/**
 * The raw adapter's `publishedHint` is a relative Indonesian string straight off the
 * `/indeks` listing (e.g. "27 menit lalu", "Rabu, 22 Juli" — see `index.js`'s
 * `extractIndeksItems` doc) with no absolute timestamp anywhere in the listing markup.
 * `discovered_urls.published_hint` is TIMESTAMPTZ, so this always resolves to `undefined`
 * for Tirto today; the real `published_at` extracted by `parse()` (DOM "Terbit" byline)
 * remains the authoritative source regardless.
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
    canonical_url: { source: 'link[rel=canonical]|og:url', confidence: 'high' },
    title: { source: 'dom:h1.article-title|og:title|title', confidence: 'high' },
    summary: { source: 'og:description|meta:description|dom:p.kicker', confidence: 'high' },
    content_text: { source: 'dom:.content-text-editor', confidence: 'high' },
    author_name: { source: 'meta:article:author|dom:.byline a.reporter-name', confidence: 'medium' },
    published_at: { source: 'dom:.byline_div_terbit', confidence: 'high' },
    updated_at_source: { source: 'meta:article:modified_time', confidence: 'medium' },
    category: { source: 'dom:.breadcrumbs-wrapper_last_item', confidence: 'medium' },
    thumbnail_url: { source: 'og:image', confidence: 'medium' },
    tags: { source: 'meta:news_keywords_filtered_by_breadcrumb', confidence: 'low' },
    external_article_id: { source: 'url_trailing_4char_code', confidence: 'high' },
  };
}

/**
 * @param {ReturnType<typeof rawTirto.parse>} draft - raw ParsedArticle-like shape.
 * @returns {Partial<import('../../core/types').ParsedArticle>} core shape (merged over
 *   pipeline defaults by `runPipeline`, see src/core/pipeline.js step 5).
 */
function toParsedArticle(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  const contentText = paragraphs.join('\n\n');
  const contentHtml = paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : undefined;

  return {
    external_article_id: draft.externalArticleId || undefined,
    canonical_url: draft.url ? rawTirto.stripPageParam(draft.url) : undefined,
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
  const raw = rawTirto.getSourceProfile();
  return {
    // snake_case: consumed by src/core/pipeline.js and the db layer (src/db/sources.js,
    // src/db/articles.js) which mirror the `sources`/`articles` table column names.
    source_id: raw.sourceId,
    display_name: raw.displayName,
    base_url: raw.baseUrl,
    adapter_version: ADAPTER_VERSION,
    allowed_domains: ['tirto.id'],
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
  return rawTirto.isArticleUrl(url, ctx);
}

/**
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<import('../../core/types').DiscoveryItem[]>}
 */
async function discover(ctx) {
  const { items } = await rawTirto.discover(ctx);
  return items.map(toCoreDiscoveryItem);
}

/**
 * @param {string} html
 * @param {import('../../core/types').CrawlContext} [ctx]
 * @returns {Promise<Partial<import('../../core/types').ParsedArticle>>}
 */
async function parse(html, ctx) {
  const draft = await rawTirto.parse(html, ctx);
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
// Wired into `src/adapters/index.js`'s ADAPTER_MODULES map by S3b-D as:
//
//   tirto: () => require('./tirto/coreAdapter'),
// ---------------------------------------------------------------------------------
