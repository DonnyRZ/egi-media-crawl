#!/usr/bin/env node
'use strict';

// Sprint 8 (S8-A) scheduler CLI: registers/updates BullMQ repeatable "job schedulers" for
// every source in SCHEDULE_SOURCES (src/sources/scheduleConfig.js, owned by S8-B) on the
// existing `crawl-discover` queue, then exits. It does NOT run/process any job itself —
// jobs the schedulers produce are picked up by the normal worker process (`npm start`,
// src/workers/index.js), which already has a `crawl-discover` handler. Run this any time
// SCHEDULE_SOURCES/SCHEDULE_INTERVAL_OVERRIDE_MINUTES/SCHEDULE_DISCOVER_LIMIT changes (or
// on every deploy) — it's idempotent (upsert semantics, see src/queue/scheduler.js).
//
// Usage:
//   node scripts/scheduler.js
//   npm run schedule
//   npm run schedule:staging   # SCHEDULE_SOURCES=detik,suara, 2-minute interval override
//   npm run schedule:all       # SCHEDULE_SOURCES=<all listAdapterIds()>, profile intervals
//
// Requires Redis (REDIS_URL); does not touch Postgres.

require('dotenv').config();

const { registerSchedules } = require('../src/queue/scheduler');
const { closeQueues } = require('../src/queue/queues');
const { closeConnection } = require('../src/queue/connection');

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

async function run() {
  if (!process.env.SCHEDULE_SOURCES || process.env.SCHEDULE_SOURCES.trim() === '') {
    log('scheduler_noop', {
      reason: 'SCHEDULE_SOURCES is unset/empty -- nothing will be scheduled (see README.md "Scheduling")',
    });
  }

  const { registered, skipped, removed } = await registerSchedules({ log });

  log('scheduler_summary', {
    registeredCount: registered.length,
    skippedCount: skipped.length,
    removedCount: removed.length,
    registered: registered.map((r) => ({
      sourceId: r.sourceId,
      intervalMinutes: r.intervalMinutes,
      limit: r.limit,
    })),
    skipped,
    removed: removed.map((r) => r.sourceId),
  });

  if (registered.length === 0 && skipped.length === 0) {
    console.log(
      '\n[scheduler] no sources registered (SCHEDULE_SOURCES is unset/empty). ' +
        'Set SCHEDULE_SOURCES (e.g. detik,suara), or use `npm run schedule:staging` / `npm run schedule:all`.'
    );
  } else {
    console.log(`\n[scheduler] registered ${registered.length} discover schedule(s):`);
    for (const r of registered) {
      console.log(
        `  - ${r.sourceId}: every ${r.intervalMinutes}m (limit=${r.limit === undefined ? 'none' : r.limit})`
      );
    }
    if (skipped.length > 0) {
      console.log(`[scheduler] skipped ${skipped.length} source(s) for safety:`);
      for (const s of skipped) {
        console.log(`  - ${s.sourceId}: ${s.reason}`);
      }
    }
    if (removed.length > 0) {
      console.log(`[scheduler] removed ${removed.length} stale schedule(s):`);
      for (const r of removed) {
        console.log(`  - ${r.sourceId}`);
      }
    }
  }

  console.log(
    '\n[scheduler] done. Jobs produced by these schedules are processed by the normal ' +
      'worker process -- make sure it is running: `npm start` (or `npm run dev`).'
  );
}

run()
  .then(async () => {
    await closeQueues();
    await closeConnection();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`[scheduler] failed: ${err && err.message ? err.message : err}`);
    await closeQueues().catch(() => {});
    await closeConnection().catch(() => {});
    process.exitCode = 1;
  });
