'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const { getConnection, closeConnection } = require('../queue/connection');
const { QUEUE_NAMES, closeQueues } = require('../queue/queues');
const { closePool } = require('../db');
const { handleEventAggregation } = require('./handlers/eventAggregation');

const LOCK_DURATION_MS = Number(process.env.EVENT_AGGREGATION_LOCK_DURATION_MS || 600_000);

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

function createAggregationWorker() {
  const worker = new Worker(
    QUEUE_NAMES.EVENT_AGGREGATION,
    async (job) => {
      log('event_aggregation_job_received', { jobId: job.id, runKey: job.data && job.data.runKey });
      const result = await handleEventAggregation(job, { log });
      log('event_aggregation_job_done', { jobId: job.id, ...result });
      return result;
    },
    {
      connection: getConnection(),
      concurrency: 1,
      lockDuration: LOCK_DURATION_MS,
      lockRenewTime: Math.max(10_000, Math.floor(LOCK_DURATION_MS / 3)),
    },
  );
  worker.on('completed', (job) => log('job_completed', { queue: QUEUE_NAMES.EVENT_AGGREGATION, jobId: job.id }));
  worker.on('failed', (job, error) => log('job_failed', { queue: QUEUE_NAMES.EVENT_AGGREGATION, jobId: job && job.id, error: error && error.message }));
  worker.on('error', (error) => log('worker_error', { queue: QUEUE_NAMES.EVENT_AGGREGATION, error: error && error.message }));
  return worker;
}

if (require.main === module) {
  const worker = createAggregationWorker();
  const shutdown = async (signal) => {
    log('shutdown_started', { signal });
    await worker.close();
    await closeQueues();
    await closeConnection();
    await closePool();
    log('shutdown_complete', { signal });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

module.exports = { LOCK_DURATION_MS, createAggregationWorker };
