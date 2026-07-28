#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { Worker, QueueEvents } = require('bullmq');
const { QUEUE_NAMES, getEventAggregationQueue, closeQueues } = require('../src/queue/queues');
const { getConnection, closeConnection } = require('../src/queue/connection');
const { handleEventAggregation } = require('../src/workers/handlers/eventAggregation');

async function main() {
  const connection = getConnection();
  const queue = getEventAggregationQueue();
  const queueEvents = new QueueEvents(QUEUE_NAMES.EVENT_AGGREGATION, { connection });
  const worker = new Worker(QUEUE_NAMES.EVENT_AGGREGATION, (job) => handleEventAggregation(job, {
    config: { enabled: true, dryRun: true, windows: [24], algorithmVersion: 'lexical-v1', maxArticles: 10, batchSize: 10 },
    getLatestCollectedAt: async () => new Date('2026-07-28T08:00:00Z'),
    getAggregationArticles: async () => [
      { article_id: 1, source_id: 'queue-a', title: 'KPK Tangkap Arman dalam Korupsi Cakra', summary: '', collected_at: '2026-07-28T07:00:00Z' },
      { article_id: 2, source_id: 'queue-b', title: 'Arman Ditangkap KPK Terkait Korupsi Cakra', summary: '', collected_at: '2026-07-28T07:05:00Z' },
    ],
    persistAggregationResult: async (result, options) => ({ persisted: false, dryRun: options.dryRun, eventCount: result.event_count }),
  }), { connection, concurrency: 1 });
  await queueEvents.waitUntilReady();
  const job = await queue.add('queue-smoke', { runKey: `queue-smoke-${Date.now()}` }, { removeOnComplete: true, removeOnFail: true });
  const result = await job.waitUntilFinished(queueEvents, 15_000);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.windows[0].persisted, false);
  assert.strictEqual(result.windows[0].eventCount, 1);
  console.log(JSON.stringify({ ok: true, queue: QUEUE_NAMES.EVENT_AGGREGATION, processed: true, dryRun: true }));
  await worker.close();
  await queueEvents.close();
  await closeQueues();
  await closeConnection();
}

main().catch(async (error) => {
  console.error('[event-aggregation-queue] failed:', error.message);
  try { await closeQueues(); await closeConnection(); } finally { process.exitCode = 1; }
});
