'use strict';
require('dotenv').config();
const fs=require('node:fs');
const {validateGate}=require('../src/radar/gate');
const db=require('../src/db/pool');
async function evaluate() {
  const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const pairs=input.pairs.filter(p=>typeof p.reviewerA==='boolean'&&p.reviewerA===p.reviewerB);
  if(pairs.length!==input.pairs.length)throw new Error('Every pair needs two agreeing independent reviewer labels; resolve disagreements first');
  const events=input.events.filter(e=>typeof e.reviewerA==='boolean'&&e.reviewerA===e.reviewerB);
  const top=input.topTen.filter(e=>typeof e.reviewerA==='boolean'&&e.reviewerA===e.reviewerB);
  if(events.length!==input.events.length || top.length!==10 || input.topTen.length!==10)throw new Error('All event groups and exactly ten recommendations need two agreeing reviewer labels');
  const tp=pairs.filter(p=>p.predictedSame&&p.reviewerA).length,fp=pairs.filter(p=>p.predictedSame&&!p.reviewerA).length,fn=pairs.filter(p=>!p.predictedSame&&p.reviewerA).length;
  const result=await db.query(`SELECT EXTRACT(EPOCH FROM(MAX(as_of)-MIN(as_of)))/3600 AS hours,
    BOOL_AND(eligible_count=processed_count AND status='succeeded') AS complete FROM radar_runs
    WHERE cohort_version=$1 AND algorithm_version=$2`,[input.cohortVersion,input.algorithmVersion]);
  const report={algorithmVersion:input.algorithmVersion,cohortVersion:input.cohortVersion,reviewers:input.reviewers,pairs:pairs.length,events:events.length,
    precision:tp/(tp+fp||1),recall:tp/(tp+fn||1),topTenUseful:top.filter(e=>e.reviewerA).length,
    shadowHours:Number(result.rows[0].hours||0),inputComplete:result.rows[0].complete===true,sourceCoverageReviewed:input.sourceCoverageReviewed===true};
  report.approved=validateGate(report);report.reviewSha256=require('node:crypto').createHash('sha256').update(JSON.stringify(input)).digest('hex');
  fs.writeFileSync(process.argv[3]||'reports/radar-approval.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));if(!report.approved)process.exitCode=1;
}
evaluate().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>db.end());
