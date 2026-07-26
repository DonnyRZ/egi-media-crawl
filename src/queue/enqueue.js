'use strict';

const crypto = require('crypto');
const { getDiscoverQueue, getFetchQueue, getParseQueue } = require('./queues');

/**
 * Job payload shapes
 * -------------------
 * These are plain, framework-agnostic objects (no core/db types are
 * imported here) so that F3/F6 can wire the real pipeline against this
 * contract without src/queue depending on src/core or src/db.
 *
 * crawl-discover  job.data:
 *   {
 *     sourceId: string,
 *     enqueuedAt: string (ISO timestamp),
 *     limit?: number   // caps discovered URLs processed; required when CRAWL_LIVE=true
 *                       // (see src/core/crawlLimit.js, src/workers/handlers/discover.js)
 *   }
 *
 * crawl-fetch  job.data:
 *   {
 *     sourceId: string,
 *     url: string,
 *     discoveryChannel?: string,   // e.g. 'latest_html' | 'category' | 'rss' | 'sitemap'
 *     listingTitle?: string,       // title hint captured at discovery time
 *     publishedHint?: string,      // ISO date hint from listing/RSS/sitemap
 *     enqueuedAt: string (ISO timestamp)
 *   }
 *
 * crawl-parse  job.data:
 *   {
 *     sourceId: string,
 *     url: string,
 *     fetchId?: string | number,   // reference to a fetch_attempts row (F2), once wired
 *     enqueuedAt: string (ISO timestamp)
 *   }
 */

// BullMQ rejects custom jobIds containing ':' (reserved for its internal
// repeatable-job key format), and URLs always contain ':' (e.g. "https://").
// Hash the identifying parts instead of joining them with a separator.
function buildJobId(prefix, ...parts) {
  const key = parts.filter((p) => p !== undefined && p !== null && p !== '').join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return `${prefix}-${hash}`;
}

/**
 * Enqueue a discovery run for one source.
 * @param {string} sourceId
 * @param {{ jobOptions?: object, dedupeKey?: string, limit?: number }} [opts] - `limit`
 *   caps how many discovered URLs the crawl-discover handler processes; required when
 *   CRAWL_LIVE=true (see src/core/crawlLimit.js). Falls back to the CRAWL_LIMIT env var
 *   in the handler if omitted here.
 */
async function enqueueDiscover(sourceId, opts = {}) {
  if (!sourceId) throw new Error('enqueueDiscover: sourceId is required');

  const queue = getDiscoverQueue();
  return queue.add(
    'discover',
    {
      sourceId,
      enqueuedAt: new Date().toISOString(),
      limit: opts.limit,
    },
    {
      // Deduped while waiting/active: re-enqueueing the same source before
      // its discovery job has been picked up is a no-op, not a duplicate.
      jobId: buildJobId('discover', sourceId, opts.dedupeKey),
      ...opts.jobOptions,
    }
  );
}

/**
 * Enqueue a fetch job for a single discovered URL.
 * @param {{ sourceId: string, url: string, discoveryChannel?: string, listingTitle?: string, publishedHint?: string }} payload
 * @param {{ jobOptions?: object }} [opts]
 */
async function enqueueFetch(payload = {}, opts = {}) {
  const { sourceId, url, discoveryChannel, listingTitle, publishedHint } = payload;
  if (!sourceId) throw new Error('enqueueFetch: sourceId is required');
  if (!url) throw new Error('enqueueFetch: url is required');

  const queue = getFetchQueue();
  return queue.add(
    'fetch',
    {
      sourceId,
      url,
      discoveryChannel,
      listingTitle,
      publishedHint,
      enqueuedAt: new Date().toISOString(),
    },
    {
      // Idempotent by (sourceId, url): the same URL discovered again via
      // another channel before it's fetched will not create a duplicate
      // job, matching the "at-least-once discovery, idempotent processing"
      // principle from the crawl playbook.
      jobId: buildJobId('fetch', sourceId, url),
      ...opts.jobOptions,
    }
  );
}

/**
 * Enqueue a parse job for a previously fetched URL.
 * @param {{ sourceId: string, url: string, fetchId?: string|number }} payload
 * @param {{ jobOptions?: object }} [opts]
 */
async function enqueueParse(payload = {}, opts = {}) {
  const { sourceId, url, fetchId } = payload;
  if (!sourceId) throw new Error('enqueueParse: sourceId is required');
  if (!url) throw new Error('enqueueParse: url is required');

  const queue = getParseQueue();
  return queue.add(
    'parse',
    {
      sourceId,
      url,
      fetchId,
      enqueuedAt: new Date().toISOString(),
    },
    {
      jobId: buildJobId('parse', sourceId, url, fetchId),
      ...opts.jobOptions,
    }
  );
}

module.exports = {
  enqueueDiscover,
  enqueueFetch,
  enqueueParse,
};
