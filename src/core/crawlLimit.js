'use strict';

/**
 * Shared "how many URLs may this discovery run process" logic (Sprint 0, live-crawl
 * safety hardening). Used by both the one-off `scripts/crawl-once.js` entrypoint and the
 * BullMQ `crawl-discover` handler (`src/workers/handlers/discover.js`) so the rule is
 * defined exactly once.
 *
 * Behavior (documented in README.md "CRAWL_LIVE (fixture vs. live crawling)"):
 *   - An explicit limit can come from `--limit=N` (crawl:once CLI arg), a BullMQ job's
 *     `limit` field, or the `CRAWL_LIMIT` env var (checked in that priority order).
 *   - When `CRAWL_LIVE` is NOT enabled, a limit is optional: returns `undefined` if none
 *     was given, so existing fixture-only adapter defaults are unaffected.
 *   - When `CRAWL_LIVE=true`, a limit is REQUIRED: this fails fast with a clear,
 *     actionable error instead of silently defaulting, so a live run can never
 *     accidentally flood a real site with an unbounded discovery pass.
 */

/**
 * @param {string|number} value
 * @param {string} label - used in the thrown error message, e.g. "--limit" or "CRAWL_LIMIT".
 * @returns {number}
 */
function parsePositiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: "${value}". It must be a positive integer (e.g. ${label}=2).`);
  }
  return n;
}

/**
 * @param {{explicitLimit?: string|number, liveCrawl: boolean}} params
 *   `explicitLimit` is whatever the caller already resolved from its own highest-priority
 *   source (CLI `--limit=`/job.data.limit); this function itself falls back to the
 *   `CRAWL_LIMIT` env var if `explicitLimit` is not provided.
 * @returns {number|undefined} the resolved limit, or `undefined` when no limit was given
 *   AND `liveCrawl` is false (fixture path keeps its own adapter-level defaults).
 * @throws {Error} if `liveCrawl` is true and no valid limit could be resolved, or if a
 *   given limit fails to parse as a positive integer.
 */
function resolveDiscoverLimit({ explicitLimit, liveCrawl } = {}) {
  let limit;

  if (explicitLimit !== undefined && explicitLimit !== null && explicitLimit !== '') {
    limit = parsePositiveInteger(explicitLimit, 'limit');
  } else if (process.env.CRAWL_LIMIT !== undefined && process.env.CRAWL_LIMIT !== '') {
    limit = parsePositiveInteger(process.env.CRAWL_LIMIT, 'CRAWL_LIMIT');
  }

  if (liveCrawl && limit === undefined) {
    throw new Error(
      'CRAWL_LIVE=true requires an explicit crawl limit — refusing to run an unbounded live ' +
        'discovery pass against a real site. Pass --limit=N (crawl:once) or set CRAWL_LIMIT=N, e.g.:\n' +
        '  CRAWL_LIVE=true npm run crawl:once -- --source=detik --limit=2\n' +
        'See README.md "CRAWL_LIVE (fixture vs. live crawling)" for details.'
    );
  }

  return limit;
}

module.exports = { resolveDiscoverLimit, parsePositiveInteger };
