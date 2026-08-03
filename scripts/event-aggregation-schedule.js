#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { getEventAggregationConfig } = require('../src/event-aggregation/config');
const { getEventAggregationQueue, closeQueues } = require('../src/queue/queues');

async function main() {
  const config = getEventAggregationConfig();
  if (!config.enabled) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'EVENT_AGGREGATION_ENABLED=false' }));
    return;
  }
  const queue = getEventAggregationQueue();
  const intervalMs = config.intervalMinutes * 60_000;
  await queue.upsertJobScheduler(
    'event-aggregation-schedule',
    { every: intervalMs },
    { name: 'aggregate-events', data: { scheduled: true, enqueuedAt: new Date().toISOString() } }
  );
  console.log(JSON.stringify({ ok: true, scheduled: true, intervalMinutes: config.intervalMinutes, windows: config.windows, dryRun: config.dryRun }));
}

main()
  .catch((error) => {
    console.error('[event-aggregation-schedule] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => closeQueues());
