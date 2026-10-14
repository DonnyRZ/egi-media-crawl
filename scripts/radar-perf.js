'use strict';
const {aggregateRadar}=require('../src/radar/engine');
const cohort={version:'perf',sources:Array.from({length:12},(_,i)=>({id:`source${i}`,group:`group${i}`,active:true,enrolledAt:'2020-01-01',channels:[]}))};
for(const size of [15000,50000]) {
  const rows=Array.from({length:size},(_,i)=>({source_id:`source${i%12}`,url:`https://news.test/${i}`,title:`KPK OTT BNPB Jakarta Dana Bantuan Kasus ${Math.floor(i/100)}`,
    published_at:new Date(Date.UTC(2026,9,14,11)-Math.floor(i/100)*1000),first_seen_at:new Date(Date.UTC(2026,9,14,11)-Math.floor(i/100)*1000)}));
  const start=performance.now();const result=aggregateRadar(rows,{cohort,asOf:new Date('2026-10-14T12:00Z'),windowHours:168});
  const durationMs=performance.now()-start,rss=process.memoryUsage().rss/1024/1024;
  console.log(JSON.stringify({size,processed:result.processedCount,events:result.events.length,comparisons:result.comparisons,durationMs,rssMiB:rss,
    passed:result.processedCount===size&&durationMs<300000&&rss<512,synthetic:true}));
  if(result.processedCount!==size||durationMs>=300000||rss>=512)process.exitCode=1;
}
