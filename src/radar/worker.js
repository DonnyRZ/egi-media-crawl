'use strict';
const {loadCohort,enabled}=require('./cohort');
const {aggregateRadar}=require('./engine');
const store=require('./store');
async function runRadar({db=require('../db/pool'),asOf=new Date(),windows=[24,72,168],cohort=loadCohort(),dryRun=false}={}) {
  const client=await db.connect();let lock=false;
  try {
    const acquired=await client.query("SELECT pg_try_advisory_lock(hashtext('editorial-radar-v2')) AS locked");lock=acquired.rows[0].locked;
    if(!lock)return {skipped:true,reason:'already_running'};
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let inputs;try {inputs=await store.readInputs({asOf,windowHours:Math.max(...windows),cohort},client);await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');throw error;}
    const results=[];
    for(const windowHours of windows) {
      const runId=dryRun?null:await store.beginRun({cohort,asOf,windowHours},db);
      try {
        const result=aggregateRadar(inputs.rows,{cohort,health:inputs.health,identities:inputs.identities,asOf,windowHours});
        if(!dryRun)await store.persistRun(runId,result,inputs.health,db);
        // Larger-window runs reuse memberships established by the smaller window.
        for(const event of result.events) for(const article of event.articles)inputs.identities.set(article.id,event.id);
        results.push({runId,windowHours,eligible:result.eligibleCount,processed:result.processedCount,events:result.events.length});
      }catch(error){if(runId)await store.failRun(runId,error,db);throw error;}
    }
    return {ok:true,cohortVersion:cohort.version,results};
  }finally {
    try {
      if(lock && !dryRun) {
        try { await store.retain(db); }
        finally { await client.query("SELECT pg_advisory_unlock(hashtext('editorial-radar-v2'))"); }
      } else if(lock) await client.query("SELECT pg_advisory_unlock(hashtext('editorial-radar-v2'))");
    } finally { client.release(); }
  }
}
async function shadowRadar(options) {if(!enabled())return {skipped:true,reason:'disabled'};return runRadar(options);}
module.exports={runRadar,shadowRadar};
