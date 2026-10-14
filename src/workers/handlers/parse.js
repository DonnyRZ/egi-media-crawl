'use strict';

const { runPipeline } = require('../../core');
const { getAdapter } = require('../../adapters');
const { fetchArticleHtml } = require('../lib/fetchHtml');
const { storeParsedArticle } = require('../../db/articles');
const { upsertProcessingStatus } = require('../../db/articles');
const cache = require('../lib/fetchCache');

/**
 * crawl-parse handler: runs the full core pipeline (normalize -> isArticleUrl -> fetch
 * -> adapter.parse -> contentHash -> store) for one URL via `runPipeline`
 * (src/core/pipeline.js), injecting the fixture-first `fetchArticleHtml` as `fetchFn`
 * and `storeParsedArticle` (src/db/articles.js) as `storeFn`. New jobs consume the
 * cached response from fetchId. Only old jobs without fetchId use the fetch helper.
 *
 * @param {import('bullmq').Job} job - job.data: { sourceId, url, fetchId? }
 * @returns {Promise<{ok: boolean, sourceId: string, url: string, status: string, reason?: string}>}
 */
async function handleParse(job,deps={}) {
  const { sourceId, url, fetchId } = job.data;
  const adapter = (deps.getAdapter||getAdapter)(sourceId);
  const cached=fetchId ? await (deps.readCache||cache.read)(sourceId,url,fetchId) : null;
  if(fetchId&&!cached) {
    await (deps.setStatus||upsertProcessingStatus)({sourceId,normalizedUrl:require('../../core/normalizeUrl').normalizeUrl(url),status:'retry_scheduled',reason:'fetch_cache_expired'});
    await (deps.enqueueFetch||require('../../queue/enqueue').enqueueFetch)({sourceId,url});
    return {ok:false,sourceId,url,status:'retry_scheduled',reason:'fetch_cache_expired'};
  }

  const result = await (deps.pipeline||runPipeline)({
    adapter,
    fetchFn: (targetUrl) => cached || fetchArticleHtml(sourceId, targetUrl),
    storeFn: deps.store||storeParsedArticle,
    url,
    ctx: { sourceId, sourceProfile: adapter.getSourceProfile() },
  });

  if(!['stored','duplicate'].includes(result.status)) {
    const retry=result.status==='retry_scheduled';
    const status=retry&&(job.attemptsMade||0)+1>=(job.opts?.attempts||3)?'dead_letter':result.status;
    await (deps.setStatus||upsertProcessingStatus)({sourceId,normalizedUrl:result.normalizedUrl||url,status,reason:result.reason});
    if(retry&&status!=='dead_letter')throw new Error(result.reason||'parse_retry');
    throw new (require('bullmq').UnrecoverableError)(result.reason||'parse_failed');
  }
  if(fetchId)await (deps.removeCache||cache.remove)(sourceId,url,fetchId);
  return {
    ok: result.status === 'stored' || result.status === 'duplicate',
    sourceId,
    url,
    status: result.status,
    reason: result.reason,
  };
}

module.exports = { handleParse };
