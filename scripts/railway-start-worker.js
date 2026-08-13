#!/usr/bin/env node
/**
 * Railway crawl-worker entry: register discover schedules, then start workers.
 *
 * `npm start` only processes queues. Repeatable discover jobs exist only after
 * `registerSchedules()`. This process keeps the worker alive after upserting.
 *
 * When CRAWL_LIVE=true and SCHEDULE_SOURCES is empty, fills SCHEDULE_SOURCES
 * from listAdapterIds() (same allow-list as `npm run schedule:all`).
 * Does not close Redis after register — workers reuse the shared connection.
 */
'use strict';

require('dotenv').config();

const { listAdapterIds } = require('../src/adapters');
const { registerSchedules } = require('../src/queue/scheduler');
const { main } = require('../src/workers/index');

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

async function start() {
  if (process.env.CRAWL_LIVE === 'true') {
    if (!process.env.SCHEDULE_SOURCES || process.env.SCHEDULE_SOURCES.trim() === '') {
      const ids = listAdapterIds();
      if (ids.length === 0) {
        throw new Error('listAdapterIds() returned no adapters — refusing to start live crawl');
      }
      process.env.SCHEDULE_SOURCES = ids.join(',');
      log('railway_worker_schedule_sources_filled', { count: ids.length });
    }
    const result = await registerSchedules({ log });
    log('railway_worker_schedules_registered', {
      registeredCount: result.registered.length,
      skippedCount: result.skipped.length,
      removedCount: result.removed.length,
      skipped: result.skipped,
    });
  } else {
    log('railway_worker_schedules_skipped', { reason: 'CRAWL_LIVE_not_true' });
  }

  main();
}

start().catch((error) => {
  log('railway_worker_start_failed', {
    error: error && error.message ? error.message : String(error),
  });
  process.exit(1);
});
