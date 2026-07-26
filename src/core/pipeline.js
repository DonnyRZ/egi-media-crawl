'use strict';

const { PROCESSING_STATUS } = require('./status');
const { computeContentHash } = require('./contentHash');
const { normalizeUrl } = require('./normalizeUrl');

/**
 * @typedef {import('./types').Adapter} Adapter
 * @typedef {import('./types').CrawlContext} CrawlContext
 * @typedef {import('./types').FetchResult} FetchResult
 * @typedef {import('./types').ParsedArticle} ParsedArticle
 */

// HTTP status classification for the default fetch-failure -> status mapping
// (playbook §13.4 "Retry"). Adapters/fetchFn implementations that need finer-grained
// control can throw an Error with `.retryable` / `.errorType` set instead of relying on
// this table (see `fetchFn` contract below).
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const BLOCKED_HTTP_STATUSES = new Set([401, 403]);

/**
 * @typedef {Object} PipelineResult
 * @property {string} status - one of PROCESSING_STATUS values (see status.js)
 * @property {string} requestedUrl - the raw url passed in to runPipeline
 * @property {string|null} normalizedUrl
 * @property {ParsedArticle|null} article
 * @property {FetchResult|null} fetchResult
 * @property {string} [reason] - short machine-readable reason code
 * @property {Error} [error] - original error, if any step threw
 * @property {{startedAt: string, endedAt: string, durationMs: number}} timing
 */

/**
 * @typedef {Object} RunPipelineParams
 * @property {Adapter} adapter - must implement isArticleUrl(url, ctx) and parse(html, ctx).
 * @property {(url: string, ctx: CrawlContext) => Promise<FetchResult>} fetchFn - injected
 *   fetch implementation. Core NEVER performs live HTTP itself; this makes runPipeline fully
 *   testable with a mock/stub. May throw an Error with optional `.retryable` (boolean) and
 *   `.errorType` (string) properties to control the resulting status.
 * @property {(article: ParsedArticle, meta: {ctx: CrawlContext, fetchResult: FetchResult}) => Promise<({status?: string, reason?: string}|void)>} [storeFn]
 *   injected persistence implementation (owned by the db-layer agent). May resolve with
 *   `{ status: PROCESSING_STATUS.DUPLICATE, reason: '...' }` etc. to override the default
 *   `stored` outcome, or throw (optionally with `.retryable`) on failure. If omitted, the
 *   pipeline stops after parsing and returns status `parsed`.
 * @property {string} url - raw URL to process (relative URLs require `ctx` / adapter to
 *   resolve them, or pass sourceProfile.normalizeUrlOptions.baseUrl).
 * @property {CrawlContext} [ctx]
 */

/**
 * Run the core discover-time-independent pipeline for a single article URL:
 *
 *   normalize URL -> adapter.isArticleUrl() -> fetchFn() -> adapter.parse() ->
 *   computeContentHash() -> storeFn()
 *
 * Design constraints (see task brief / playbook §6.1, §23.4):
 *   - No BullMQ, no pg, no live HTTP inside core. `fetchFn` and `storeFn` are injected by the
 *     caller (worker layer), so this function can be unit-tested end-to-end with plain mocks.
 *   - Never throws for expected failure modes (bad URL, non-2xx fetch, parse error, store
 *     error) — it always resolves with a `PipelineResult` carrying a status from
 *     `PROCESSING_STATUS`, so every URL gets a traceable outcome (playbook §3.3, §21.4).
 *   - Only throws for programmer errors (missing required params).
 *
 * @param {RunPipelineParams} params
 * @returns {Promise<PipelineResult>}
 */
async function runPipeline({ adapter, fetchFn, storeFn, url, ctx = {} }) {
  const startedAt = new Date();
  const timing = () => ({
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  });

  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('runPipeline: adapter is required');
  }
  if (typeof adapter.isArticleUrl !== 'function' || typeof adapter.parse !== 'function') {
    throw new TypeError('runPipeline: adapter must implement isArticleUrl() and parse()');
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError('runPipeline: fetchFn is required (core does not perform HTTP itself)');
  }
  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('runPipeline: url is required');
  }

  const baseResult = { requestedUrl: url };

  // 1. Normalize
  let normalizedUrl;
  try {
    const profile = typeof adapter.getSourceProfile === 'function' ? adapter.getSourceProfile() : undefined;
    const normalizeOptions = (profile && profile.normalizeUrlOptions) || {};
    normalizedUrl = normalizeUrl(url, normalizeOptions);
  } catch (error) {
    return {
      ...baseResult,
      status: PROCESSING_STATUS.INVALID,
      normalizedUrl: null,
      article: null,
      fetchResult: null,
      reason: 'url_normalization_failed',
      error,
      timing: timing(),
    };
  }

  // 2. Validate via adapter
  let isArticle;
  try {
    isArticle = adapter.isArticleUrl(normalizedUrl, ctx);
  } catch (error) {
    return {
      ...baseResult,
      status: PROCESSING_STATUS.INVALID,
      normalizedUrl,
      article: null,
      fetchResult: null,
      reason: 'is_article_url_threw',
      error,
      timing: timing(),
    };
  }

  if (!isArticle) {
    return {
      ...baseResult,
      status: PROCESSING_STATUS.IGNORED_BY_POLICY,
      normalizedUrl,
      article: null,
      fetchResult: null,
      reason: 'not_article_url',
      timing: timing(),
    };
  }

  // 3. Fetch (injected — core never calls the network directly)
  let fetchResult;
  try {
    fetchResult = await fetchFn(normalizedUrl, ctx);
  } catch (error) {
    const retryable = error && error.retryable === true;
    return {
      ...baseResult,
      status: retryable ? PROCESSING_STATUS.RETRY_SCHEDULED : PROCESSING_STATUS.DEAD_LETTER,
      normalizedUrl,
      article: null,
      fetchResult: null,
      reason: (error && error.errorType) || 'fetch_threw',
      error,
      timing: timing(),
    };
  }

  if (!fetchResult || typeof fetchResult.status !== 'number') {
    return {
      ...baseResult,
      status: PROCESSING_STATUS.INVALID,
      normalizedUrl,
      article: null,
      fetchResult: fetchResult || null,
      reason: 'invalid_fetch_result_shape',
      timing: timing(),
    };
  }

  if (fetchResult.status < 200 || fetchResult.status >= 300) {
    let status = PROCESSING_STATUS.DEAD_LETTER;
    if (RETRYABLE_HTTP_STATUSES.has(fetchResult.status)) {
      status = PROCESSING_STATUS.RETRY_SCHEDULED;
    } else if (BLOCKED_HTTP_STATUSES.has(fetchResult.status)) {
      status = PROCESSING_STATUS.BLOCKED;
    }
    return {
      ...baseResult,
      status,
      normalizedUrl,
      article: null,
      fetchResult,
      reason: `http_status_${fetchResult.status}`,
      timing: timing(),
    };
  }

  // 4. Parse via adapter
  let parsed;
  try {
    parsed = await adapter.parse(fetchResult.body, ctx);
  } catch (error) {
    return {
      ...baseResult,
      status: PROCESSING_STATUS.INVALID,
      normalizedUrl,
      article: null,
      fetchResult,
      reason: 'parse_failed',
      error,
      timing: timing(),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ...baseResult,
      status: PROCESSING_STATUS.INVALID,
      normalizedUrl,
      article: null,
      fetchResult,
      reason: 'parse_returned_empty',
      timing: timing(),
    };
  }

  // 5. Content hash
  const contentHash = computeContentHash(parsed.title, parsed.content_text);

  const sourceProfile = typeof adapter.getSourceProfile === 'function' ? adapter.getSourceProfile() : undefined;

  /** @type {ParsedArticle} */
  const article = {
    source_id: sourceProfile && sourceProfile.source_id,
    adapter_version: sourceProfile && sourceProfile.adapter_version,
    requested_url: url,
    final_url: fetchResult.finalUrl || normalizedUrl,
    normalized_url: normalizedUrl,
    canonical_url: null,
    collected_at: new Date().toISOString(),
    ...parsed,
    content_hash: contentHash,
  };

  // Sprint 2 P0 hardening: canonical_url has no pipeline-computed default (unlike
  // source_id/adapter_version/collected_at/content_hash above), so a bridge that fails to
  // derive one would otherwise leave `canonical_url: null` and get silently DEAD_LETTER'd at
  // store time (src/db/articles.js REQUIRED_ARTICLE_FIELDS + the DB's NOT NULL constraint)
  // instead of surfacing as a contract violation. Fall back to normalizedUrl/finalUrl —
  // still correct identity-wise for single-page articles, just without multipage/tracking
  // -param collapsing a real canonical tag would give you.
  if (!article.canonical_url) {
    article.canonical_url = article.normalized_url || article.final_url || null;
  }

  // No storeFn injected: caller only wants discovery+fetch+parse, stop here.
  if (typeof storeFn !== 'function') {
    return {
      ...baseResult,
      status: PROCESSING_STATUS.PARSED,
      normalizedUrl,
      article,
      fetchResult,
      reason: 'no_store_fn_provided',
      timing: timing(),
    };
  }

  // 6. Store
  try {
    const storeOutcome = await storeFn(article, { ctx, fetchResult });
    const status = (storeOutcome && storeOutcome.status) || PROCESSING_STATUS.STORED;
    return {
      ...baseResult,
      status,
      normalizedUrl,
      article,
      fetchResult,
      reason: storeOutcome && storeOutcome.reason,
      timing: timing(),
    };
  } catch (error) {
    const retryable = error && error.retryable === true;
    return {
      ...baseResult,
      status: retryable ? PROCESSING_STATUS.RETRY_SCHEDULED : PROCESSING_STATUS.DEAD_LETTER,
      normalizedUrl,
      article,
      fetchResult,
      reason: (error && error.errorType) || 'store_failed',
      error,
      timing: timing(),
    };
  }
}

module.exports = { runPipeline };
