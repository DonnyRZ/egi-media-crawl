'use strict';

const { Queue } = require('bullmq');
const { getConnection } = require('./connection');

/**
 * Queue topology
 * --------------
 * Approach chosen: one QUEUE PER PIPELINE STAGE instead of a single `crawl`
 * queue with a `jobType` field. Rationale:
 *
 *  - Each stage has different characteristics: discovery is cheap and runs
 *    per source, fetch is the stage that must respect per-source rate
 *    limits (see rateLimits.js), and parse is CPU-bound with no outbound
 *    HTTP. Separate queues let each stage get its own concurrency setting
 *    without one stage starving another (BullMQ concurrency/limiter options
 *    are configured per Worker/queue, not per job name).
 *  - A pipeline stage backing up or failing for one source (e.g. fetch
 *    errors) does not block jobs sitting in other stages' queues.
 *  - It matches the "per-media isolation" and "queue partition per source"
 *    principles in Reliable-News-Article-Scraping.md (sections 4.6, 5).
 *
 * Queue names / responsibilities:
 *  - crawl-discover : one job per source; finds candidate article URLs
 *                      (discovery only, does not fetch full articles).
 *  - crawl-fetch     : one job per (sourceId, url); downloads a single
 *                      article page/response.
 *  - crawl-parse     : one job per (sourceId, url); parses/validates a
 *                      previously-fetched response into article data.
 *
 * See src/queue/enqueue.js for the exact job payload shape of each queue.
 */
const QUEUE_NAMES = {
  DISCOVER: 'crawl-discover',
  FETCH: 'crawl-fetch',
  PARSE: 'crawl-parse',
};

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};

const queues = {};

function getQueue(name) {
  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: getConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return queues[name];
}

function getDiscoverQueue() {
  return getQueue(QUEUE_NAMES.DISCOVER);
}

function getFetchQueue() {
  return getQueue(QUEUE_NAMES.FETCH);
}

function getParseQueue() {
  return getQueue(QUEUE_NAMES.PARSE);
}

async function closeQueues() {
  const open = Object.values(queues);
  for (const name of Object.keys(queues)) {
    delete queues[name];
  }
  await Promise.all(open.map((q) => q.close()));
}

module.exports = {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  getQueue,
  getDiscoverQueue,
  getFetchQueue,
  getParseQueue,
  closeQueues,
};
