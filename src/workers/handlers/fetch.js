'use strict';

const { fetchArticleHtml } = require('../lib/fetchHtml');
const { enqueueParse } = require('../../queue/enqueue');

/**
 * crawl-fetch handler: performs (or, for fixture-mode sources, simulates) the actual
 * HTTP fetch for one URL, then hands off to crawl-parse on success. The per-source
 * rate-limit delay (src/queue/rateLimits.js) is applied by the caller
 * (src/workers/index.js) right before this runs, not inside this handler.
 *
 * The `crawl-parse` stage (src/workers/handlers/parse.js) re-fetches via the same
 * `fetchArticleHtml` helper inside `runPipeline` — for fixture-mode sources that's just
 * a cheap local file re-read, so this stage mainly exists to validate reachability /
 * honor rate limits before work is queued further, matching the discover -> fetch ->
 * parse staged-queue design in src/queue/queues.js.
 *
 * @param {import('bullmq').Job} job - job.data: { sourceId, url, ... }
 * @returns {Promise<{ok: boolean, sourceId: string, url: string, status: number}>}
 */
async function handleFetch(job) {
  const { sourceId, url } = job.data;

  const result = await fetchArticleHtml(sourceId, url);
  const ok = result.status >= 200 && result.status < 300;

  if (ok) {
    await enqueueParse({ sourceId, url });
  }

  return { ok, sourceId, url, status: result.status };
}

module.exports = { handleFetch };
