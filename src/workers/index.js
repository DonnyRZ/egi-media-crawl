'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const { getConnection, closeConnection } = require('../queue/connection');
const { QUEUE_NAMES, closeQueues } = require('../queue/queues');
const { getFetchDelayMs } = require('../queue/rateLimits');
const { closePool } = require('../db');
const { handleDiscover } = require('./handlers/discover');
const { handleFetch } = require('./handlers/fetch');
const { handleParse } = require('./handlers/parse');

// Basic concurrency config via env, e.g. WORKER_CONCURRENCY=2.
// Applies to every stage worker (discover/fetch/parse) in this process.
const WORKER_CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY, 10) || 2;

// Hard ceiling so a stuck in-flight job cannot hang process managers forever.
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

// In-memory, single-process stub for per-source rate limiting on the fetch
// stage (see src/queue/rateLimits.js for the delay values/TODO). Not shared
// across multiple worker processes.
const lastFetchAtBySource = new Map();

async function respectFetchDelay(sourceId) {
  const delayMs = getFetchDelayMs(sourceId);
  const lastAt = lastFetchAtBySource.get(sourceId) || 0;
  const wait = delayMs - (Date.now() - lastAt);
  if (wait > 0) {
    await sleep(wait);
  }
  lastFetchAtBySource.set(sourceId, Date.now());
}

async function handleDiscoverJob(job) {
  const { sourceId } = job.data;
  log('discover_job_received', { jobId: job.id, sourceId });

  const result = await handleDiscover(job, { log });

  log('discover_job_done', { jobId: job.id, sourceId, discovered: result.discovered, enqueued: result.enqueued });
  return result;
}

async function handleFetchJob(job) {
  const { sourceId, url } = job.data;
  log('fetch_job_received', { jobId: job.id, sourceId, url });

  await respectFetchDelay(sourceId);
  const result = await handleFetch(job);

  log('fetch_job_done', { jobId: job.id, sourceId, url, status: result.status });
  return result;
}

async function handleParseJob(job) {
  const { sourceId, url, fetchId } = job.data;
  log('parse_job_received', { jobId: job.id, sourceId, url, fetchId });

  const result = await handleParse(job);

  log('parse_job_done', { jobId: job.id, sourceId, url, fetchId, status: result.status, reason: result.reason });
  return result;
}

const HANDLERS = {
  [QUEUE_NAMES.DISCOVER]: handleDiscoverJob,
  [QUEUE_NAMES.FETCH]: handleFetchJob,
  [QUEUE_NAMES.PARSE]: handleParseJob,
};

function createWorker(queueName, handler) {
  const worker = new Worker(queueName, handler, {
    connection: getConnection(),
    concurrency: WORKER_CONCURRENCY,
  });

  worker.on('completed', (job) => {
    log('job_completed', { queue: queueName, jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    log('job_failed', { queue: queueName, jobId: job && job.id, error: err && err.message });
  });

  worker.on('error', (err) => {
    log('worker_error', { queue: queueName, error: err && err.message });
  });

  return worker;
}

function startWorkers() {
  log('workers_starting', {
    concurrency: WORKER_CONCURRENCY,
    queues: Object.values(QUEUE_NAMES),
  });

  const workers = Object.entries(HANDLERS).map(([queueName, handler]) => createWorker(queueName, handler));

  log('workers_started', { count: workers.length });

  return workers;
}

/** @type {Promise<void> | null} */
let shutdownPromise = null;

/**
 * Graceful shutdown for the worker process (VPS-ready):
 *   1. Stop accepting new jobs (`Worker.close` waits for in-flight work)
 *   2. Close any Queue clients opened by handlers (enqueue)
 *   3. Quit the shared Redis connection
 *   4. Drain the shared pg Pool
 *   5. Exit 0 (or 1 on hard failure / forced timeout)
 *
 * Idempotent: concurrent SIGINT+SIGTERM (or a second signal) share one promise
 * and cannot race a double-close / double-exit.
 *
 * @param {import('bullmq').Worker[]} workers
 * @param {string} [signal]
 * @param {{ exitProcess?: boolean }} [opts]
 */
function shutdown(workers, signal = 'manual', opts = {}) {
  const exitProcess = opts.exitProcess !== false;

  if (shutdownPromise) {
    log('shutdown_already_in_progress', { signal });
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    log('shutdown_started', { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });

    let forceTimer = null;
    if (exitProcess) {
      forceTimer = setTimeout(() => {
        log('shutdown_forced', { signal, afterMs: SHUTDOWN_TIMEOUT_MS });
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      // Don't keep the event loop alive solely for the force timer.
      if (typeof forceTimer.unref === 'function') forceTimer.unref();
    }

    try {
      await Promise.all((workers || []).map((worker) => worker.close()));
      await closeQueues();
      await closeConnection();
      await closePool();
      log('shutdown_complete', { signal });
      if (forceTimer) clearTimeout(forceTimer);
      if (exitProcess) process.exit(0);
    } catch (err) {
      log('shutdown_error', { signal, error: err && err.message });
      if (forceTimer) clearTimeout(forceTimer);
      if (exitProcess) process.exit(1);
      throw err;
    }
  })();

  return shutdownPromise;
}

function installSignalHandlers(workers) {
  const onSignal = (signal) => {
    // Fire-and-forget; shutdown() owns exit codes and is idempotent.
    void shutdown(workers, signal);
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

function main() {
  const workers = startWorkers();
  installSignalHandlers(workers);
  return workers;
}

if (require.main === module) {
  main();
}

module.exports = {
  startWorkers,
  shutdown,
  installSignalHandlers,
  main,
  SHUTDOWN_TIMEOUT_MS,
};
