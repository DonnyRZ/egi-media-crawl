'use strict';
const pool = () => require('../db/pool');
const { VERSION } = require('./engine');
async function recordHealth({sourceId,channel,state,reason=null,count=0,complete=false,watermark=null,cursor={}},db=pool()) {
  await db.query(`WITH saved AS (INSERT INTO radar_source_health(source_id,channel,last_attempt_at,last_success_at,state,reason,discovered_count,complete,watermark_at,cursor)
    VALUES($1,$2,clock_timestamp(),CASE WHEN $3='healthy' THEN clock_timestamp() ELSE NULL END,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(source_id,channel) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,
    last_success_at=COALESCE(EXCLUDED.last_success_at,radar_source_health.last_success_at),state=EXCLUDED.state,
    reason=EXCLUDED.reason,discovered_count=EXCLUDED.discovered_count,complete=EXCLUDED.complete,
    watermark_at=CASE WHEN EXCLUDED.complete THEN COALESCE(EXCLUDED.watermark_at,radar_source_health.watermark_at) ELSE radar_source_health.watermark_at END,cursor=EXCLUDED.cursor RETURNING *)
    INSERT INTO radar_source_checks(source_id,channel,state,complete,reason)
    SELECT source_id,channel,state,complete,reason FROM saved`,
  [sourceId,channel,state,reason,count,complete,watermark,JSON.stringify(cursor)]);
}
async function recordObservation({sourceId,item,category},db=pool()) {
  if(!item.title_hint || !item.published_hint || /fixture/i.test(item.channel||'')) return;
  const at=new Date(item.published_hint);if(!Number.isFinite(at.getTime())||at>Date.now())return;
  await db.query(`INSERT INTO radar_observations(source_id,normalized_url,title,published_at,channel,category)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,normalized_url) DO UPDATE SET
    title=EXCLUDED.title,published_at=EXCLUDED.published_at,last_seen_at=clock_timestamp(),channel=EXCLUDED.channel,category=COALESCE(EXCLUDED.category,radar_observations.category)`,
  [sourceId,item.metadata?.normalizedUrlHint||item.url,item.title_hint,at,item.channel||'official_listing',category||null]);
}
async function readInputs({asOf,windowHours,cohort},db=pool()) {
  const ids=cohort.sources.filter(s=>s.active).map(s=>s.id);
  // No LIMIT. The repeatable-read transaction pins the same wall-clock snapshot across windows.
  const rows=await db.query(`WITH full_articles AS (
    SELECT a.article_id::text, a.source_id, a.canonical_url AS url, a.title, COALESCE(a.summary,'') AS summary,
      LEFT(a.content_text,800) AS lead, a.content_hash, a.category, COALESCE(a.published_at,a.first_discovered_at) AS published_at,
      a.first_discovered_at AS first_seen_at, 'full_text'::text AS evidence_quality, 'article'::text AS channel
    FROM articles a WHERE a.validation_status='valid' AND a.source_id=ANY($1::text[])
      AND COALESCE(a.published_at,a.first_discovered_at) >= $2::timestamptz - ($3*INTERVAL '1 hour')
      AND COALESCE(a.published_at,a.first_discovered_at)<=$2::timestamptz
      AND a.first_discovered_at<=$2::timestamptz
      AND NOT EXISTS(SELECT 1 FROM discovered_urls d WHERE d.source_id=a.source_id
        AND d.normalized_url=a.normalized_url AND d.discovery_channel ILIKE '%fixture%')
  ) SELECT * FROM full_articles UNION ALL
    SELECT 'observation-'||o.observation_id,o.source_id,o.normalized_url,o.title,'' AS summary,'' AS lead,
      NULL AS content_hash,o.category,o.published_at,o.first_seen_at,'listing_only',o.channel
    FROM radar_observations o WHERE o.source_id=ANY($1::text[]) AND o.published_at >= $2::timestamptz-($3*INTERVAL '1 hour')
      AND o.published_at<=$2::timestamptz AND o.first_seen_at<=$2::timestamptz AND NOT EXISTS(
        SELECT 1 FROM articles a WHERE a.source_id=o.source_id AND a.validation_status='valid'
        AND (a.canonical_url=o.normalized_url OR a.normalized_url=o.normalized_url))`,[ids,asOf,windowHours]);
  const health=await db.query('SELECT * FROM radar_source_health WHERE source_id=ANY($1::text[])',[ids]);
  const history=await db.query(`SELECT source_id,channel,attempted_at,state,complete FROM radar_source_checks
    WHERE source_id=ANY($1::text[]) AND attempted_at>=$2::timestamptz-INTERVAL '14 hours'
    AND attempted_at<=$2::timestamptz ORDER BY attempted_at`,[ids,asOf]);
  const version=await db.query('SELECT created_at FROM radar_cohorts WHERE version=$1',[cohort.version]);
  const comparable=require('./health').comparableChannels(health.rows,history.rows,cohort,asOf,version.rows[0]?.created_at);
  const identities=await db.query(`SELECT observation_key,event_id FROM radar_members WHERE last_seen_at >= $1::timestamptz-INTERVAL '7 days'`,[asOf]);
  return {rows:rows.rows,health:comparable,identities:new Map(identities.rows.map(r=>[r.observation_key,r.event_id]))};
}
async function beginRun({cohort,asOf,windowHours},db=pool()) {
  await db.query('INSERT INTO radar_cohorts(version,sources) VALUES($1,$2) ON CONFLICT DO NOTHING',[cohort.version,JSON.stringify(cohort.sources)]);
  const {rows}=await db.query(`INSERT INTO radar_runs(window_hours,cohort_version,algorithm_version,as_of,status)
    VALUES($1,$2,$3,$4,'running') RETURNING run_id`,[windowHours,cohort.version,VERSION,asOf]);
  return rows[0].run_id;
}
async function failRun(id,error,db=pool()) { await db.query(`UPDATE radar_runs SET status='failed',finished_at=clock_timestamp(),error_message=$2 WHERE run_id=$1`,[id,String(error.message).slice(0,1000)]); }
async function persistRun(id,result,health,db=pool()) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    for(let offset=0;offset<result.events.length;offset+=100) {
      const events=result.events.slice(offset,offset+100);
      const compact=events.map(({articles,...event})=>({...event,run_id:id}));
      await client.query(`INSERT INTO radar_events(event_id,last_seen_at) SELECT x->>'id',$2 FROM jsonb_array_elements($1::jsonb)x
        ON CONFLICT(event_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,[JSON.stringify(compact),result.asOf]);
      await client.query(`INSERT INTO radar_snapshots(run_id,event_id,title,category,score,payload)
        SELECT $2,x->>'id',x->>'title',x->>'category',(x->>'score')::numeric,x FROM jsonb_array_elements($1::jsonb)x`,[JSON.stringify(compact),id]);
      const members=events.flatMap(event=>event.articles.map(article=>({eventId:event.id,key:article.id,payload:article})));
      await client.query(`INSERT INTO radar_members(event_id,observation_key,last_seen_at)
        SELECT x->>'eventId',x->>'key',$2 FROM jsonb_array_elements($1::jsonb)x
        ON CONFLICT(observation_key) DO UPDATE SET event_id=EXCLUDED.event_id,last_seen_at=EXCLUDED.last_seen_at`,[JSON.stringify(members),result.asOf]);
      await client.query(`INSERT INTO radar_run_members(run_id,event_id,observation_key,payload)
        SELECT $2,x->>'eventId',x->>'key',x->'payload' FROM jsonb_array_elements($1::jsonb)x`,[JSON.stringify(members),id]);
    }
    await client.query(`UPDATE radar_runs SET status='succeeded',eligible_count=$2,processed_count=$3,event_count=$4,
      health=$5,finished_at=clock_timestamp() WHERE run_id=$1`,[id,result.eligibleCount,result.processedCount,result.events.length,JSON.stringify(health)]);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
async function retain(db=pool()) {
  await db.query(`DELETE FROM radar_run_members WHERE run_id IN(SELECT run_id FROM radar_runs WHERE finished_at< NOW()-INTERVAL '7 days')`);
  await db.query(`DELETE FROM radar_runs WHERE status!='running' AND finished_at<NOW()-INTERVAL '30 days'`);
  await db.query(`UPDATE radar_runs SET status='failed',finished_at=clock_timestamp(),error_message='Interrupted or exceeded run timeout'
    WHERE status='running' AND started_at<NOW()-INTERVAL '30 minutes'`);
  await db.query(`DELETE FROM radar_members WHERE last_seen_at<NOW()-INTERVAL '30 days'`);
  await db.query(`DELETE FROM radar_source_checks WHERE attempted_at<NOW()-INTERVAL '7 days'`);
  await db.query(`DELETE FROM radar_events e WHERE e.last_seen_at<NOW()-INTERVAL '30 days'
    AND NOT EXISTS(SELECT 1 FROM radar_snapshots s WHERE s.event_id=e.event_id)
    AND NOT EXISTS(SELECT 1 FROM radar_members m WHERE m.event_id=e.event_id)`);
}
module.exports={recordHealth,recordObservation,readInputs,beginRun,persistRun,failRun,retain};
