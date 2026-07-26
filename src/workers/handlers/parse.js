'use strict';

const { runPipeline } = require('../../core');
const { getAdapter } = require('../../adapters');
const { fetchArticleHtml } = require('../lib/fetchHtml');
const { storeParsedArticle } = require('../../db/articles');

/**
 * crawl-parse handler: runs the full core pipeline (normalize -> isArticleUrl -> fetch
 * -> adapter.parse -> contentHash -> store) for one URL via `runPipeline`
 * (src/core/pipeline.js), injecting the fixture-first `fetchArticleHtml` as `fetchFn`
 * and `storeParsedArticle` (src/db/articles.js) as `storeFn`.
 *
 * @param {import('bullmq').Job} job - job.data: { sourceId, url, fetchId? }
 * @returns {Promise<{ok: boolean, sourceId: string, url: string, status: string, reason?: string}>}
 */
async function handleParse(job) {
  const { sourceId, url } = job.data;
  const adapter = getAdapter(sourceId);

  const result = await runPipeline({
    adapter,
    fetchFn: (targetUrl) => fetchArticleHtml(sourceId, targetUrl),
    storeFn: storeParsedArticle,
    url,
    ctx: { sourceId, sourceProfile: adapter.getSourceProfile() },
  });

  return {
    ok: result.status === 'stored' || result.status === 'duplicate',
    sourceId,
    url,
    status: result.status,
    reason: result.reason,
  };
}

module.exports = { handleParse };
