'use strict';
require('dotenv').config();
const fs=require('node:fs');
const path=require('node:path');
const {loadCohort}=require('../src/radar/cohort');
const {getAdapter}=require('../src/adapters');
const {official}=require('../src/radar/discovery');
async function main() {
  if(!process.argv.includes('--live'))throw new Error('This read-only network probe requires --live; it never enrolls sources automatically');
  process.env.CRAWL_LIVE='true';
  const cohort=loadCohort(),results=[];
  const sources=cohort.sources.filter(s=>s.active);
  for(let offset=0;offset<sources.length;offset+=3)await Promise.all(sources.slice(offset,offset+3).map(async source=>{
    const start=Date.now();
    try {
      const adapter=getAdapter(source.id);
      for(const channel of source.channels) {
      const items=await adapter.discover({fixtureOnly:false,liveDiscover:true,limit:100,...channel.options,discoverMaxPages:2,logger:{warn:()=>{}},maxPages:2});
      const verified=items.filter(item=>item.title_hint&&official(item.url,source));
      results.push({sourceId:source.id,channel:channel.id,desks:channel.desks,state:verified.length?'reachable':'empty',listingCount:verified.length,
        datedCount:verified.filter(item=>item.published_hint&&Number.isFinite(new Date(item.published_hint).getTime())).length,
        partialFailure:items.partialFailure||null,durationMs:Date.now()-start,
        note:'Reachability is not proof of pagination or complete desk coverage; requires channel review.'});
      }
    }catch(error){results.push({sourceId:source.id,state:'unavailable_from_local_probe',reason:error.message,durationMs:Date.now()-start});}
  }));
  results.sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
  const report={at:new Date().toISOString(),cohortVersion:cohort.version,location:'local development network',productionUntouched:true,results};
  const file=path.resolve(process.argv.find(v=>v.startsWith('--output='))?.slice(9)||'reports/radar-source-validation.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({file,...report}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
