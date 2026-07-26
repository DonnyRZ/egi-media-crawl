'use strict';

const { getDiscoverQueue } = require('./queues');
const { listSchedulableSources, getDiscoverJobOptions } = require('../sources/scheduleConfig');
const { isLiveCrawlEnabled } = require('../workers/lib/fetchHtml');

/**
 * BullMQ repeatable-job scheduler for `crawl-discover` (Sprint 8, S8-A).
 *
 * Consumes the read-only config surface built by S8-B (`src/sources/scheduleConfig.js`) —
 * this module owns no env-var parsing of its own beyond what that module already exposes.
 * It only decides *how to turn that config into BullMQ "Job Scheduler" state* (the
 * `queue.upsertJobScheduler()`/`getJobSchedulers()`/`removeJobScheduler()` API — the
 * non-deprecated replacement for BullMQ's older `repeat`/`removeRepeatable` API, see
 * `queue.js` in `node_modules/bullmq`), and does not itself run/process any job — that's
 * still `npm start` (`src/workers/index.js`), which already has a `crawl-discover` worker.
 *
 * ## Upsert semantics / stable IDs
 *
 * Every scheduled source gets a BullMQ job-scheduler id of `discover-schedule:<sourceId>`
 * (`buildSchedulerId`). Re-running `registerSchedules()` with the same `SCHEDULE_SOURCES`
 * is idempotent: `upsertJobScheduler()` with the same id just overwrites the existing
 * scheduler's repeat options/template in place (BullMQ's `override: true`), so changing
 * `SCHEDULE_INTERVAL_OVERRIDE_MINUTES`/`SCHEDULE_DISCOVER_LIMIT` and re-running updates the
 * existing schedule instead of creating a second, duplicate one.
 *
 * When `SCHEDULE_SOURCES` shrinks (a source is removed from the allow-list, or a
 * previously-registered source is now skipped for safety — see below), the corresponding
 * `discover-schedule:<sourceId>` scheduler is actively removed via `removeJobScheduler()`
 * so it stops producing jobs, rather than being silently left running. Only schedulers
 * whose id starts with the `discover-schedule:` prefix are ever touched — any other
 * scheduler/repeatable job in this queue (e.g. registered manually, or by another
 * process) is left alone.
 *
 * ## Safety: no unbounded live schedules
 *
 * If `CRAWL_LIVE=true` and `getDiscoverJobOptions(sourceId).limit` is `undefined` (no
 * `SCHEDULE_DISCOVER_LIMIT`/`CRAWL_LIMIT` resolvable — see `scheduleConfig.js`), that
 * source is *not* registered: the `crawl-discover` handler enforces this too
 * (`resolveDiscoverLimit`, throws at job-run time), but failing here means the scheduler
 * never even creates the recurring job, and logs loudly (`scheduler_skip_unbounded_live`)
 * so a misconfigured staging/prod env is obvious from the CLI output instead of silently
 * producing jobs that then fail repeatedly.
 */

const SCHEDULER_ID_PREFIX = 'discover-schedule:';

/** @param {string} sourceId @returns {string} */
function buildSchedulerId(sourceId) {
  return `${SCHEDULER_ID_PREFIX}${sourceId}`;
}

/** @param {string} schedulerId @returns {string|null} */
function sourceIdFromSchedulerId(schedulerId) {
  return typeof schedulerId === 'string' && schedulerId.startsWith(SCHEDULER_ID_PREFIX)
    ? schedulerId.slice(SCHEDULER_ID_PREFIX.length)
    : null;
}

/**
 * @param {import('bullmq').Queue} queue
 * @returns {Promise<Array<{key: string}>>} job schedulers owned by this module (id prefix
 *   `discover-schedule:`), i.e. excludes any other scheduler/repeatable job on the queue.
 */
async function listOwnedSchedulers(queue) {
  const schedulers = await queue.getJobSchedulers();
  return schedulers.filter((scheduler) => sourceIdFromSchedulerId(scheduler.key) !== null);
}

/**
 * Reads `listSchedulableSources()`/`getDiscoverJobOptions()` and upserts one BullMQ job
 * scheduler per schedulable source on the `crawl-discover` queue, then removes any
 * `discover-schedule:*` scheduler this module owns that is no longer desired (source
 * dropped from `SCHEDULE_SOURCES`, or skipped this run for the unbounded-live-limit safety
 * check above).
 *
 * @param {{log?: Function, queue?: import('bullmq').Queue}} [opts] - `log` defaults to
 *   `console.log`; `queue` defaults to the shared `crawl-discover` Queue instance
 *   (overridable for tests).
 * @returns {Promise<{
 *   registered: Array<{sourceId: string, schedulerId: string, intervalMinutes: number, limit: number|undefined, everyMs: number}>,
 *   skipped: Array<{sourceId: string, reason: string}>,
 *   removed: Array<{sourceId: string, schedulerId: string}>,
 * }>}
 */
async function registerSchedules(opts = {}) {
  const log = opts.log || console.log;
  const queue = opts.queue || getDiscoverQueue();
  const liveCrawl = isLiveCrawlEnabled();

  const sourceIds = listSchedulableSources();

  const registered = [];
  const skipped = [];

  for (const sourceId of sourceIds) {
    const jobOptions = getDiscoverJobOptions(sourceId);

    if (liveCrawl && jobOptions.limit === undefined) {
      log('scheduler_skip_unbounded_live', {
        sourceId,
        reason:
          'CRAWL_LIVE=true but no resolvable discover limit for this source ' +
          '(set SCHEDULE_DISCOVER_LIMIT or CRAWL_LIMIT) -- refusing to register an unbounded live schedule',
      });
      skipped.push({ sourceId, reason: 'unbounded_live_limit' });
      continue;
    }

    const schedulerId = buildSchedulerId(sourceId);
    const everyMs = jobOptions.intervalMinutes * 60_000;

    await queue.upsertJobScheduler(
      schedulerId,
      { every: everyMs },
      {
        name: 'discover',
        data: {
          sourceId,
          limit: jobOptions.limit,
          scheduled: true,
        },
      }
    );

    registered.push({
      sourceId,
      schedulerId,
      intervalMinutes: jobOptions.intervalMinutes,
      limit: jobOptions.limit,
      everyMs,
    });
    log('scheduler_registered', {
      sourceId,
      schedulerId,
      intervalMinutes: jobOptions.intervalMinutes,
      limit: jobOptions.limit,
    });
  }

  const desiredSchedulerIds = new Set(registered.map((r) => r.schedulerId));
  const owned = await listOwnedSchedulers(queue);

  const removed = [];
  for (const scheduler of owned) {
    if (desiredSchedulerIds.has(scheduler.key)) continue;

    await queue.removeJobScheduler(scheduler.key);
    const sourceId = sourceIdFromSchedulerId(scheduler.key) || scheduler.key;
    removed.push({ sourceId, schedulerId: scheduler.key });
    log('scheduler_removed', {
      sourceId,
      schedulerId: scheduler.key,
      reason: 'not in current SCHEDULE_SOURCES (or skipped this run for safety)',
    });
  }

  return { registered, skipped, removed };
}

module.exports = {
  SCHEDULER_ID_PREFIX,
  buildSchedulerId,
  sourceIdFromSchedulerId,
  listOwnedSchedulers,
  registerSchedules,
};
