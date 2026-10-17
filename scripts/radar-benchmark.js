'use strict';
// Export real candidate evidence for two independent human reviewers. No inferred gold labels.
require('dotenv').config();
const fs=require('node:fs');
const path=require('node:path');
const db=require('../src/db/pool');
const {loadCohort}=require('../src/radar/cohort');
const {memberPayloadSql}=require('../src/radar/memberPayload');
async function exportReview() {
  const directory=path.resolve(process.argv[2]||'reports/radar-review');fs.mkdirSync(directory,{recursive:true});
  const latest=await db.query(`SELECT * FROM radar_runs WHERE window_hours=168 AND status='succeeded' ORDER BY finished_at DESC LIMIT 1`);
  if(!latest.rows[0])throw new Error('Run a local shadow snapshot before exporting reviewer samples');
  const run=latest.rows[0];
  const snapshots=await db.query('SELECT event_id,category,payload FROM radar_snapshots WHERE run_id=$1 ORDER BY score DESC,event_id',[run.run_id]);
  const members=await db.query(`SELECT event_id,observation_key,${memberPayloadSql('member')} AS payload
    FROM radar_run_members member WHERE run_id=$1 ORDER BY event_id,observation_key`,[run.run_id]);
  const byEvent=new Map();for(const row of members.rows){if(!byEvent.has(row.event_id))byEvent.set(row.event_id,[]);byEvent.get(row.event_id).push(row.payload);}
  const categories=['business','technology','politics','sports','entertainment'];
  const sample=categories.flatMap(category=>snapshots.rows.filter(e=>e.category===category).slice(0,20));
  const pairs=[];
  for(let i=0;i<sample.length;i++) {
    const event=sample[i],own=byEvent.get(event.event_id)||[];
    for(let n=0;n<3&&n+1<own.length;n++)pairs.push({id:`${i}-same-${n}`,left:own[0],right:own[n+1],predictedSame:true,reviewerA:null,reviewerB:null});
    for(let n=1;n<=5&&sample.length>n;n++) {
      const other=sample[(i+n)%sample.length],different=byEvent.get(other.event_id)||[];
      if(own[0]&&different[0])pairs.push({id:`${i}-different-${n}`,left:own[0],right:different[0],predictedSame:false,reviewerA:null,reviewerB:null});
    }
  }
  const data={algorithmVersion:run.algorithm_version,cohortVersion:run.cohort_version,runId:String(run.run_id),exportedAt:new Date().toISOString(),
    instructions:'Review independently: true means the same parent event, false means different events. Resolve disagreements before evaluation. Never treat predictedSame as a gold label.',
    reviewers:[],pairs:pairs.slice(0,600),events:sample.map(e=>({...e.payload,articles:byEvent.get(e.event_id),reviewerA:null,reviewerB:null})),
    topTen:snapshots.rows.filter(e=>e.payload.recommendation!=='insufficient').slice(0,10).map(e=>({event:e.payload,reviewerA:null,reviewerB:null})),
    cohort:loadCohort(),minimumReady:pairs.length>=500&&sample.length>=100};
  fs.writeFileSync(path.join(directory,'review.json'),JSON.stringify(data,null,2));
  console.log(JSON.stringify({directory,pairs:data.pairs.length,events:data.events.length,minimumReady:data.minimumReady,quality:'pending_human_review'}));
}
exportReview().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>db.end());
