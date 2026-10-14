'use strict';
const {loadCohort,enabled,available}=require('./cohort');
function availability(run,cohort,now=Date.now()) {
  if(!run)return 'warming_up';
  if(now-new Date(run.as_of).getTime()>30*60000)return 'stale';
  if(run.cohort_version!==cohort.version||Number(run.eligible_count)!==Number(run.processed_count))return 'degraded';
  const health=run.health||[];
  for(const source of cohort.sources.filter(s=>s.active)) for(const channel of source.channels) {
    const h=health.find(h=>h.source_id===source.id&&h.channel===channel.id);
    if(!h || h.state!=='healthy' || !h.complete || now-new Date(h.last_success_at).getTime()>2*source.intervalMinutes*60000)return 'degraded';
  }
  return 'ready';
}
function meta(run,cohort) {return {windowHours:Number(run?.window_hours||24),availability:availability(run,cohort),
  algorithmVersion:run?.algorithm_version||'editorial-radar-v2',cohortVersion:run?.cohort_version||cohort.version,
  asOf:run?.as_of||null,finishedAt:run?.finished_at||null,runId:run?String(run.run_id):null,
  eligibleCount:Number(run?.eligible_count||0),processedCount:Number(run?.processed_count||0),
  inputComplete:!!run&&Number(run.eligible_count)===Number(run.processed_count),shadow:!available(),sources:cohort.sources};}
async function status(db) {
  const cohort=loadCohort();
  if(!enabled())return {...meta(null,cohort),enabled:false,health:[],message:'Radar candidate is disabled; legacy method remains active.'};
  const health=await db.query('SELECT * FROM radar_source_health ORDER BY source_id,channel');
  const runs=await db.query('SELECT * FROM radar_runs ORDER BY started_at DESC LIMIT 9');
  const attempts=await db.query(`SELECT source_id,COUNT(*)::int AS attempts,
    COUNT(*) FILTER(WHERE http_status BETWEEN 200 AND 299)::int AS succeeded,
    COUNT(*) FILTER(WHERE http_status IN(401,403))::int AS blocked,
    COUNT(*) FILTER(WHERE error_type='retry_scheduled')::int AS retry_scheduled
    FROM fetch_attempts WHERE attempted_at>=NOW()-INTERVAL '24 hours' GROUP BY source_id`);
  const pending=await db.query(`SELECT source_id,status,COUNT(*)::int AS count FROM processing_status
    WHERE status IN('discovered','queued','fetching','retry_scheduled','fetched','parsed') GROUP BY source_id,status`);
  const states=health.rows.map(h=>{
    const source=cohort.sources.find(s=>s.id===h.source_id);
    return {...h,state:Date.now()-new Date(h.last_attempt_at).getTime()>(2*(source?.intervalMinutes||60)+10)*60000?'stale':h.state};
  });
  return {...meta(runs.rows.find(r=>r.status==='succeeded'),cohort),enabled:true,health:states,runs:runs.rows,attempts:attempts.rows,pending:pending.rows};
}
async function readRecommendations({db,windowHours=24,page=1,limit=20,search='',category='',trend=''}={}) {
  const cohort=loadCohort();
  if(!enabled())return {items:[],page,limit,total:0,total_pages:0,meta:{...meta(null,cohort),enabled:false}};
  const {rows}=await db.query(`SELECT * FROM radar_runs WHERE window_hours=$1 AND status='succeeded'
    ORDER BY finished_at DESC,run_id DESC LIMIT 1`,[windowHours]);
  const run=rows[0];
  if(!run)return {items:[],page,limit,total:0,total_pages:0,meta:meta(null,cohort)};
  const params=[run.run_id,search||null,category||null,trend||null];
  const where=`run_id=$1 AND payload->>'recommendation'!='insufficient'
    AND ($2::text IS NULL OR title ILIKE '%'||$2||'%')
    AND ($3::text IS NULL OR category=$3) AND ($4::text IS NULL OR payload->>'trend'=$4)`;
  const total=await db.query(`SELECT COUNT(*)::int AS total FROM radar_snapshots WHERE ${where}`,params);
  const events=await db.query(`SELECT payload FROM radar_snapshots WHERE ${where}
    ORDER BY score DESC,(payload->'components'->>'breadth')::numeric DESC,payload->>'lastDevelopedAt' DESC,event_id
    LIMIT $5 OFFSET $6`,[...params,limit,(page-1)*limit]);
  return {items:events.rows.map(r=>({...r.payload,articles:[],timeline:(r.payload.timeline||[]).slice(-10)})),
    page,limit,total:total.rows[0].total,total_pages:Math.ceil(total.rows[0].total/limit),meta:meta(run,cohort)};
}
async function readDetail({db,id,windowHours=24,page=1,limit=20,runId=null}) {
  if(!/^radar-[a-f0-9]{24}$/.test(id))throw Object.assign(new Error('Invalid event ID'),{status:400});
  if(!enabled())throw Object.assign(new Error('Radar candidate disabled'),{status:503});
  const run=await db.query(`SELECT * FROM radar_runs WHERE window_hours=$1 AND status='succeeded'
    AND ($2::bigint IS NULL OR run_id=$2) ORDER BY finished_at DESC,run_id DESC LIMIT 1`,[windowHours,runId]);
  const snapshot=run.rows[0]&&await db.query('SELECT payload FROM radar_snapshots WHERE run_id=$1 AND event_id=$2',[run.rows[0].run_id,id]);
  if(!snapshot?.rows[0])throw Object.assign(new Error('Event is outside the selected snapshot'),{status:404});
  const result=await db.query(`SELECT payload FROM radar_run_members WHERE run_id=$1 AND event_id=$2
    ORDER BY payload->>'publishedAt' DESC,observation_key LIMIT $3 OFFSET $4`,[run.rows[0].run_id,id,limit,(page-1)*limit]);
  const total=await db.query('SELECT COUNT(*)::int AS total FROM radar_run_members WHERE run_id=$1 AND event_id=$2',[run.rows[0].run_id,id]);
  return {item:{...snapshot.rows[0].payload,articles:result.rows.map(r=>r.payload)},page,limit,total:total.rows[0].total,
    total_pages:Math.ceil(total.rows[0].total/limit),meta:meta(run.rows[0],loadCohort())};
}
module.exports={status,readRecommendations,readDetail,availability};
