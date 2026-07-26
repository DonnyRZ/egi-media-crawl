'use strict';

const { getSource } = require('./registry');
const { parsePositiveInteger } = require('../core/crawlLimit');

/**
 * Schedule/overlap/rate config surface for the (BullMQ repeatable-job) scheduler owned by
 * S8-A (`src/queue/scheduler.js` / `scripts/scheduler.js` -- NOT this module). This module
 * answers "what sources may be scheduled, how often, with what limit/overlap" by reading
 * each adapter's `SourceProfile` (`src/sources/registry.js`) plus a small set of env vars,
 * scoped ONLY for staging-safe scheduling (Sprint 8 = `detik`/`suara`). Adaptive scheduling
 * and full watermark tracking (playbook §20.4/§20.5) are explicitly OUT of scope here.
 *
 * ## Env vars
 *
 * - `SCHEDULE_SOURCES` (required, comma-separated sourceIds, e.g. `"detik,suara"`) -- the
 *   explicit allow-list of sources the scheduler may run. There is deliberately NO "all
 *   enabled sources" default: `listSchedulableSources()` returns `[]` when this is unset, so
 *   a scheduler process can never accidentally start cron-style discovery for all 17
 *   onboarded sources just because they're `enabled` in their profile. Opt in explicitly:
 *   `SCHEDULE_SOURCES=detik,suara`, `npm run schedule:staging`, or `npm run schedule:all`
 *   (registry-derived full allow-list via `scripts/schedule-all.js`).
 * - `SCHEDULE_INTERVAL_OVERRIDE_MINUTES` (optional, positive integer) -- overrides every
 *   scheduled source's `crawl_interval_minutes` uniformly. Use this for staging soak tests
 *   that need a short interval (e.g. `1`-`2` minutes) without editing adapter profiles.
 * - `SCHEDULE_DISCOVER_LIMIT` (optional, positive integer) -- overrides `CRAWL_LIMIT`
 *   specifically for scheduler-enqueued discover jobs. Falls back to `CRAWL_LIMIT`
 *   (`src/core/crawlLimit.js`), then to `undefined` (no explicit limit; the `crawl-discover`
 *   handler / `resolveDiscoverLimit` still enforce/require one when `CRAWL_LIVE=true`).
 *
 * ## Exported API (frozen for S8-A)
 *
 * - `listSchedulableSources()` -> `string[]`
 * - `getScheduleIntervalMinutes(sourceId)` -> `number`
 * - `getDiscoverJobLimit(sourceId)` -> `number|undefined`
 * - `getOverlapHours(sourceId)` -> `number`
 * - `getDiscoverJobOptions(sourceId)` -> `{ sourceId, limit, intervalMinutes, overlapHours }`
 */

/**
 * @param {string|undefined} raw
 * @returns {string[]} trimmed, non-empty, order-preserved, de-duplicated sourceIds.
 */
function parseSourceList(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const seen = new Set();
  const result = [];
  for (const part of raw.split(',')) {
    const sourceId = part.trim();
    if (sourceId.length === 0 || seen.has(sourceId)) continue;
    seen.add(sourceId);
    result.push(sourceId);
  }
  return result;
}

/**
 * @param {string} sourceId
 * @returns {import('./registry').RegistryEntry}
 * @throws {Error} if `sourceId` has no registered adapter (see `src/adapters/index.js`).
 */
function requireSource(sourceId) {
  const entry = getSource(sourceId);
  if (!entry) {
    throw new Error(`scheduleConfig: unknown sourceId "${sourceId}" (no registered adapter)`);
  }
  return entry;
}

/**
 * Resolves the `SCHEDULE_SOURCES` allow-list against the registry.
 *
 * - Unset/empty `SCHEDULE_SOURCES` -> `[]` (schedule nothing; see module doc "safety by
 *   default" rationale).
 * - A listed sourceId with no registered adapter -> throws (fail fast on typos/renames
 *   rather than silently scheduling nothing for that entry).
 * - A listed sourceId whose profile has `enabled: false` -> silently skipped (a disabled
 *   source is a legitimate, non-error state; it just isn't schedulable).
 *
 * @returns {string[]} sourceIds safe to schedule, in `SCHEDULE_SOURCES` order.
 */
function listSchedulableSources() {
  const requested = parseSourceList(process.env.SCHEDULE_SOURCES);
  if (requested.length === 0) {
    return [];
  }

  return requested.filter((sourceId) => {
    const entry = requireSource(sourceId);
    return entry.profile.enabled !== false;
  });
}

/**
 * @param {string} sourceId
 * @returns {number} minutes between scheduled discover runs for this source: the
 *   `SCHEDULE_INTERVAL_OVERRIDE_MINUTES` env var if set, else the source's own
 *   `crawl_interval_minutes` (profile field, see `src/adapters/_template/index.js`).
 * @throws {Error} if neither an override nor a valid profile value is available.
 */
function getScheduleIntervalMinutes(sourceId) {
  requireSource(sourceId);

  if (process.env.SCHEDULE_INTERVAL_OVERRIDE_MINUTES !== undefined && process.env.SCHEDULE_INTERVAL_OVERRIDE_MINUTES !== '') {
    return parsePositiveInteger(process.env.SCHEDULE_INTERVAL_OVERRIDE_MINUTES, 'SCHEDULE_INTERVAL_OVERRIDE_MINUTES');
  }

  const entry = requireSource(sourceId);
  const minutes = entry.profile.crawl_interval_minutes ?? entry.profile.crawlIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`scheduleConfig: source "${sourceId}" has no valid crawl_interval_minutes in its profile`);
  }
  return minutes;
}

/**
 * @param {string} sourceId
 * @returns {number|undefined} the discover job's item limit: `SCHEDULE_DISCOVER_LIMIT` if
 *   set, else `CRAWL_LIMIT`, else `undefined` (no explicit limit -- see module doc).
 */
function getDiscoverJobLimit(sourceId) {
  requireSource(sourceId);

  if (process.env.SCHEDULE_DISCOVER_LIMIT !== undefined && process.env.SCHEDULE_DISCOVER_LIMIT !== '') {
    return parsePositiveInteger(process.env.SCHEDULE_DISCOVER_LIMIT, 'SCHEDULE_DISCOVER_LIMIT');
  }
  if (process.env.CRAWL_LIMIT !== undefined && process.env.CRAWL_LIMIT !== '') {
    return parsePositiveInteger(process.env.CRAWL_LIMIT, 'CRAWL_LIMIT');
  }
  return undefined;
}

/**
 * @param {string} sourceId
 * @returns {number} the source's overlap window in hours (profile `overlap_hours`, playbook
 *   §20.2).
 * @throws {Error} if the profile has no valid `overlap_hours`.
 */
function getOverlapHours(sourceId) {
  const entry = requireSource(sourceId);
  const hours = entry.profile.overlap_hours ?? entry.profile.overlapHours;
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`scheduleConfig: source "${sourceId}" has no valid overlap_hours in its profile`);
  }
  return hours;
}

/**
 * Convenience bundle of everything a scheduler needs to enqueue one discover job for
 * `sourceId` (see `src/queue/enqueue.js` `enqueueDiscover(sourceId, { limit })` and
 * `src/workers/handlers/discover.js`, which independently derives `overlapCutoffAt` from the
 * same `overlap_hours` profile field at job-run time).
 *
 * @param {string} sourceId
 * @returns {{sourceId: string, limit: number|undefined, intervalMinutes: number, overlapHours: number}}
 */
function getDiscoverJobOptions(sourceId) {
  requireSource(sourceId);
  return {
    sourceId,
    limit: getDiscoverJobLimit(sourceId),
    intervalMinutes: getScheduleIntervalMinutes(sourceId),
    overlapHours: getOverlapHours(sourceId),
  };
}

module.exports = {
  listSchedulableSources,
  getScheduleIntervalMinutes,
  getDiscoverJobLimit,
  getOverlapHours,
  getDiscoverJobOptions,
  // exported for unit tests / debugging in isolation.
  parseSourceList,
};
