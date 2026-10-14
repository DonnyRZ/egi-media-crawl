'use strict';

const { fetchArticleHtml } = require('../lib/fetchHtml');
const { enqueueParse } = require('../../queue/enqueue');
const { UnrecoverableError } = require('bullmq');
const { upsertProcessingStatus } = require('../../db/articles');
const { normalizeUrl } = require('../../core/normalizeUrl');
const cache = require('../lib/fetchCache');

/**
 * crawl-fetch handler: performs (or, for fixture-mode sources, simulates) the actual
 * HTTP fetch for one URL, then hands off to crawl-parse on success. The per-source
 * rate-limit delay (src/queue/rateLimits.js) is applied by the caller
 * (src/workers/index.js) right before this runs, not inside this handler.
 *
 * Every HTTP outcome is audited. A successful response is cached under fetchId;
 * parse consumes that same response. Retryable failures throw for BullMQ backoff,
 * while blocked/nonretryable outcomes fail without retrying the same attempt.
 *
 * @param {import('bullmq').Job} job - job.data: { sourceId, url, ... }
 * @returns {Promise<{ok: boolean, sourceId: string, url: string, status: number}>}
 */
async function handleFetch(job, deps={}) {
  const { sourceId, url } = job.data;
  const normalizedUrl=normalizeUrl(url);
  const db=deps.db||require('../../db/pool');
  const setStatus=deps.setStatus||upsertProcessingStatus;
  const start=Date.now(),number=(job.attemptsMade||0)+1;
  await setStatus({sourceId,normalizedUrl,status:'fetching',reason:`attempt_${number}`});
  let result,error;
  try{result=await (deps.fetch||fetchArticleHtml)(sourceId,url);}catch(e){error=e;}
  const ok=!error&&result.status>=200&&result.status<300;
  const blocked=[401,403].includes(result?.status);
  const retryable=!!error || result?.status===429 || result?.status>=500;
  const exhausted=number >= (job.opts?.attempts||3);
  const status=ok?'fetched':blocked?'blocked':retryable&&!exhausted?'retry_scheduled':'dead_letter';
  const reason=error?.code||error?.message||`http_${result?.status}`;
  const attempt=await db.query(`INSERT INTO fetch_attempts(source_id,normalized_url,attempted_at,attempt_number,http_status,response_time_ms,
    response_bytes,final_url,error_type,error_message,retry_scheduled_at)
    VALUES($1,$2,clock_timestamp(),$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN NOW()+INTERVAL '1 minute' ELSE NULL END) RETURNING fetch_id`,
    [sourceId,normalizedUrl,number,result?.status||null,Date.now()-start,Buffer.byteLength(result?.body||''),result?.finalUrl||url,
      ok?null:status,ok?null:String(reason).slice(0,500),status==='retry_scheduled']);
  await setStatus({sourceId,normalizedUrl,status,reason:ok?'fetch_ok':reason});
  if(!ok) {
    if(status==='retry_scheduled')throw error||new Error(reason);
    throw new UnrecoverableError(reason);
  }
  const fetchId=attempt.rows[0].fetch_id;
  await (deps.save||cache.save)(sourceId,url,fetchId,result);
  await (deps.enqueueParse||enqueueParse)({sourceId,url,fetchId});
  return {ok:true,sourceId,url,status:result.status,fetchId};
}

module.exports = { handleFetch };
