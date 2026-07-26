'use strict';

// N5 LOCKED n5.v1 — see docs/N5_CONTRACT_LOCKED.md

/**
 * Shared JSDoc typedefs for the crawler core (playbook §19, §31).
 *
 * This module has NO runtime behavior. It exists purely so other core/adapter/worker modules
 * can reference these shapes via:
 *
 *   /** @typedef {import('../core/types').ParsedArticle} ParsedArticle *\/
 *
 * Field names intentionally mirror the `articles` table (playbook §19.4) and the
 * `DiscoveryItem` / `ParsedArticle` dataclasses in §31.1-31.2, translated to plain
 * snake_case object shapes so they can be persisted directly by the (future) db layer.
 */

/**
 * Technical configuration + documentation for a single media source. This is the JS-side
 * counterpart of the YAML "source profile" described in playbook §7.2. Adapters expose one
 * of these via `getSourceProfile()`; the registry/db layer (owned by other agents) is
 * responsible for loading/persisting it.
 *
 * @typedef {Object} SourceProfile
 * @property {string} source_id - Stable slug, e.g. "media_a".
 * @property {string} display_name
 * @property {string} base_url
 * @property {string} adapter_version - e.g. "media_a_v1", stored on every article/result.
 * @property {string[]} [allowed_domains] - Domains considered "in scope" for this source.
 * @property {string} [timezone] - IANA timezone, e.g. "Asia/Jakarta".
 * @property {number} [crawl_interval_minutes]
 * @property {number} [overlap_hours] - Re-crawl window, see playbook §20.2.
 * @property {import('./normalizeUrl').NormalizeUrlOptions} [normalizeUrlOptions] - Per-source
 *   overrides passed to core `normalizeUrl()` (extra tracking params, trailing slash policy, etc).
 * @property {Object} [policy] - e.g. { respect_robots, allow_browser_rendering, store_full_content }.
 * @property {Object} [discovery] - Free-form discovery config (latest/categories/pagination/rss/sitemaps).
 * @property {Object} [article] - Free-form parser config (selectors, url_patterns, json_ld_types).
 */

/**
 * A single candidate article URL surfaced by one discovery channel (Latest, category, API,
 * RSS, sitemap...). See playbook §9.1 and §31.1.
 *
 * @typedef {Object} DiscoveryItem
 * @property {string} url - Raw (possibly relative) URL as seen on the listing/API/feed.
 * @property {string} channel - Discovery channel identifier, e.g. "latest_html", "api:business".
 * @property {string} [external_id] - Source-native article id, if the channel exposes one.
 * @property {string} [title_hint] - Listing title, used only as a low-confidence fallback.
 * @property {string} [published_hint] - ISO 8601 string; listing-reported publish time.
 * @property {string} [category_hint]
 * @property {string|number} [listing_page] - Page number/cursor the item was seen on.
 * @property {Object} [metadata] - Anything else the adapter wants to carry through for auditing.
 */

/**
 * Aggregate result of running `adapter.discover(ctx)` for one source run. Core does not
 * require adapters to return this shape directly (adapters may just yield/return
 * `DiscoveryItem[]`), but orchestration code that wraps discovery SHOULD produce this shape
 * for logging/metrics (playbook §3.5, §21.1).
 *
 * @typedef {Object} DiscoveryResult
 * @property {string} source_id
 * @property {DiscoveryItem[]} items
 * @property {number} raw_count - Items yielded before dedup/filtering.
 * @property {number} unique_count - Unique normalized URLs after dedup.
 * @property {string} started_at - ISO 8601
 * @property {string} finished_at - ISO 8601
 * @property {string[]} [errors] - Non-fatal channel errors (e.g. one category page failed).
 */

/**
 * Result of fetching a single URL. This is the shape the pipeline expects back from the
 * injected `fetchFn` (core never performs the HTTP call itself, see pipeline.js).
 *
 * @typedef {Object} FetchResult
 * @property {number} status - HTTP status code (required).
 * @property {string} [finalUrl] - URL after following redirects.
 * @property {string} [body] - Response body (HTML/JSON text).
 * @property {Object<string,string>} [headers] - Subset of response headers relevant to
 *   processing, e.g. { 'content-type': ..., 'last-modified': ..., 'etag': ... }. Callers
 *   should avoid passing the full raw header object to keep this serializable/small.
 * @property {Object} [timing] - { startedAt: ISOString, endedAt: ISOString, durationMs: number }.
 * @property {boolean} [fromCache] - True if served via conditional request (304) / local cache.
 */

/**
 * Normalized article record produced by the pipeline after `adapter.parse()`. Field names
 * mirror the `articles` table columns (playbook §19.4, plus the N5 normalized-field-contract
 * additions in db/migrations/002_add_summary_language_provenance.sql) so a db-layer (owned by
 * another agent) can persist this object close to as-is.
 *
 * Fields NOT listed here (`validation_status`, `validation_warnings`, `first_discovered_at`,
 * `last_seen_at`) are store/pipeline-owned: adapters should never set them. `validation_status`/
 * `validation_warnings` are populated by the (future) validation step and/or the db layer
 * (e.g. `src/db/articles.js` appends a `missing_published_at` warning when `published_at` is
 * absent instead of rejecting the article); `first_discovered_at`/`last_seen_at` are derived
 * from `collected_at` and wall-clock time by `upsertArticle`.
 *
 * Required-ness legend for this typedef (Sprint 2 gap-audit fix — `canonical_url` was
 * previously mis-marked optional even though it has no safe fallback, see below):
 *   - **pipeline-guaranteed** (bracket notation is correct here): `source_id`,
 *     `adapter_version`, `collected_at`, `content_hash` — `runPipeline` (pipeline.js) always
 *     fills these in from `getSourceProfile()`/wall clock/`computeContentHash()`, so an
 *     adapter omitting them is harmless.
 *   - **adapter/bridge MUST supply, no fallback** (no brackets): `canonical_url`, `title`,
 *     `content_text` — plus `requested_url`/`final_url`/`normalized_url`, which are filled in
 *     by the pipeline itself (not the adapter) from the URL/fetch step, so they're also
 *     effectively guaranteed by the time `storeFn` sees the article.
 *
 * @typedef {Object} ParsedArticle
 * @property {string} [source_id]
 * @property {string} [external_article_id]
 * @property {string} requested_url
 * @property {string} final_url
 * @property {string} canonical_url
 * @property {string} normalized_url
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} content_text
 * @property {string} [content_html]
 * @property {string} [summary] - Short dek/summary, e.g. lede paragraph or meta description.
 * @property {string} [author_name]
 * @property {string} [category]
 * @property {string[]} [tags]
 * @property {string} [thumbnail_url]
 * @property {string} [published_at] - ISO 8601. Soft-required: missing values are recorded as
 *   a `validation_warnings` entry by the store layer rather than rejected (see
 *   `src/db/articles.js` REQUIRED_ARTICLE_FIELDS comment).
 * @property {string} [updated_at_source] - ISO 8601, publisher-reported update time.
 * @property {string} [language] - Best-effort ISO 639-1 code (e.g. "id", "en"), adapter-supplied.
 * @property {string} [collected_at] - ISO 8601, set by the pipeline.
 * @property {string} [content_hash] - Set by the pipeline via contentHash.js.
 * @property {string} [adapter_version]
 * @property {string} [parser_version]
 * @property {Object} [field_provenance] - Per-field extraction metadata, e.g.
 *   { published_at: { source: 'json_ld', confidence: 'high' } }. Stored as-is in the
 *   `articles.field_provenance` JSONB column; optional and may be omitted entirely.
 */

/**
 * Per-run context passed into every adapter method. Core owns the shape; concrete fields
 * (http client, logger, config) are wired up by the worker/orchestrator layer (other agents),
 * NOT by src/core itself, so core stays free of BullMQ/pg/live HTTP dependencies.
 *
 * @typedef {Object} CrawlContext
 * @property {string} [sourceId]
 * @property {SourceProfile} [sourceProfile]
 * @property {(relativeUrl: string) => string} [absoluteUrl] - Resolve a relative URL against base_url.
 * @property {Object} [logger] - Structured logger, e.g. { info, warn, error }.
 * @property {Object} [now] - Injectable clock for deterministic tests, e.g. `() => Date`.
 * @property {Object} [extra] - Free-form bag for adapter-specific needs.
 */

/**
 * The contract every per-source adapter (src/sources/**, "F5 territory") must implement.
 * See adapterContract.js for the runtime-checkable version of this list and
 * README section "Adapter interface" at the bottom of this repo's F3 handoff notes.
 *
 * @typedef {Object} Adapter
 * @property {string} [source_id]
 * @property {string} [adapter_version]
 * @property {(ctx: CrawlContext) => (AsyncIterable<DiscoveryItem>|Iterable<DiscoveryItem>|Promise<DiscoveryItem[]>)} discover
 *   Required. Yield/return candidate article URLs for this source.
 * @property {(url: string, ctx: CrawlContext) => Promise<FetchResult>} [fetchArticle]
 *   Optional. Only implement if the source needs adapter-owned fetch logic (e.g. a signed
 *   private API client). By default core fetches via an injected `fetchFn` (see pipeline.js)
 *   and this method is not called.
 * @property {(html: string, ctx: CrawlContext) => (ParsedArticle|Promise<ParsedArticle>)} parse
 *   Required. Turn a fetched response body into a (partial) ParsedArticle. Core fills in
 *   requested_url/final_url/normalized_url/collected_at/content_hash automatically.
 * @property {(url: string, ctx: CrawlContext) => boolean} isArticleUrl
 *   Required. Cheap, synchronous URL-shape check (no network) used to filter discovery output
 *   and to short-circuit the pipeline before fetching.
 * @property {() => SourceProfile} [getSourceProfile]
 *   Optional but recommended. Used by the pipeline to read `normalizeUrlOptions`/`source_id`.
 * @property {(url: string, ctx: CrawlContext) => string} [normalizeUrl]
 *   Optional. Source-specific extra normalization layered on top of core normalizeUrl.js
 *   (e.g. stripping a source's own non-standard tracking params or slug variants).
 */

module.exports = {};
