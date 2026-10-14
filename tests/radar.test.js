'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregateRadar,tokens}=require('../src/radar/engine');
const {availability}=require('../src/radar/api');
const {validateGate}=require('../src/radar/gate');
const {handleFetch}=require('../src/workers/handlers/fetch');
const {parseFeed,discoverChannel}=require('../src/radar/discovery');
const now='2026-10-14T12:00:00Z';
const cohort={version:'test',sources:['a','b','c','d'].map(id=>({id,label:id,active:true,group:id,hosts:['news.test'],enrolledAt:'2020-01-01',intervalMinutes:30,channels:[{id:'index',kind:'adapter',desks:[]}]}))};
const health=cohort.sources.map(s=>({source_id:s.id,channel:'index',state:'healthy',complete:true,last_success_at:now}));
function rows(titles) {return titles.map((title,i)=>({source_id:cohort.sources[i%4].id,title,url:`https://news.test/${i}`,published_at:'2026-10-14T11:00:00Z',first_seen_at:'2026-10-14T11:05:00Z',evidence_quality:'full_text'}));}
function run(input,options={}) {return aggregateRadar(input,{cohort,health,asOf:now,...options});}
test('short acronyms and numeric evidence survive normalization',()=>{assert(tokens('BI 6 ECB 4').includes('bi'));assert(tokens('BI 6 ECB 4').includes('6'));});
test('different institution and interest rate are not one event',()=>{assert.equal(run(rows(['BI Pertahankan Suku Bunga 6 Persen','ECB Pertahankan Suku Bunga 4 Persen'])).events.length,2);});
test('alias and incident context bridge paraphrased airline news',()=>{assert.equal(run(rows(['Garuda GA123 Mendarat Darurat di Makassar','Gangguan Hidrolik Pesawat Garuda di Ujung Pandang'])).events.length,1);});
test('awards share a parent but preserve institution angles',()=>{const r=run(rows(['PLN Raih Penghargaan BUMN Terbaik Tahun 2026','Pegadaian Raih Penghargaan BUMN Terbaik Tahun 2026']));assert.equal(r.events.length,1);assert.equal(r.events[0].angles.length,2);});
test('popular distinctive anchors survive high frequency',()=>{for(const n of [39,41,60]){const r=run(rows(Array(n).fill('KPK OTT BNPB Jakarta Pemeriksaan Dana Bantuan')));assert.equal(r.events.length,1);assert.equal(r.events[0].articleCount,n);}});
test('duplicates, fixture, invalid and future timestamps are excluded',()=>{
  const input=rows(['KPK OTT BNPB Jakarta Dana Bantuan']);
  input.push({...input[0]}, {...input[0],url:'https://news.test/future',published_at:'2027-01-01'}, {...input[0],url:'https://news.test/fixture',channel:'fixture'}, {...input[0],url:'https://news.test/date',published_at:null});
  assert.equal(run(input).processedCount,1);
});
test('refreshing crawl timestamp cannot refresh event freshness',()=>{
  const input=rows(Array(3).fill('KPK OTT BNPB Jakarta Dana Bantuan'));
  const before=run(input).events[0];const after=run(input.map(r=>({...r,collected_at:now,last_seen_at:now}))).events[0];
  assert.deepEqual(after.components,before.components);assert.equal(after.id,before.id);
});
test('backfill and enrollment cannot create momentum',()=>{const input=rows(Array(3).fill('KPK OTT BNPB Jakarta Dana Bantuan')).map(r=>({...r,first_seen_at:now,published_at:'2026-10-14T08:00:00Z'}));assert.equal(run(input).events[0].components.momentum,0);});
test('source outage remains in breadth denominator and is not comparable',()=>{
  const input=rows(Array(3).fill('KPK OTT BNPB Jakarta Dana Bantuan'));
  const a=run(input).events[0],b=run(input,{health:health.filter(h=>h.source_id!=='a')}).events[0];
  assert.equal(a.components.breadth,b.components.breadth);assert.equal(b.comparableGroups,3);
});
test('unverified owners cannot create independent group votes',()=>{
  const input=rows(Array(3).fill('KPK OTT BNPB Jakarta Dana Bantuan'));
  const unverified={...cohort,sources:cohort.sources.map(s=>({...s,ownershipVerified:false}))};
  const event=run(input,{cohort:unverified}).events[0];assert.equal(event.groupCount,0);assert.equal(event.recommendation,'insufficient');
});
test('momentum compares a continuous same-cohort twelve-hour health history',()=>{
  const {comparableChannels}=require('../src/radar/health');
  const history=Array.from({length:25},(_,i)=>({source_id:'a',channel:'index',attempted_at:new Date(new Date(now).getTime()-i*30*60000),state:'healthy',complete:true})).reverse();
  const good=comparableChannels(health,history,cohort,now,'2026-10-13');assert.equal(good.find(h=>h.source_id==='a').comparable,true);
  history[10].state='failed';assert.equal(comparableChannels(health,history,cohort,now,'2026-10-13').find(h=>h.source_id==='a').comparable,false);
  history[10].state='healthy';assert.equal(comparableChannels(health,history,cohort,now,now).find(h=>h.source_id==='a').comparable,false);
});
test('all five editorial desks retain canonical category labels',()=>{
  for(const category of ['business','technology','politics','sports','entertainment'])assert.equal(run(rows(['An unrelated headline']).map(row=>({...row,category}))).events[0].category,category);
});
test('identical full-text copies cannot multiply independent votes',()=>{
  const input=rows(Array(3).fill('KPK OTT BNPB Jakarta Dana Bantuan')).map(r=>({...r,content_hash:'same-copy'}));
  const event=run(input).events[0];assert.equal(event.independentGroupCount,1);assert.equal(event.recommendation,'insufficient');
});
test('same syndicated lead with edited headlines receives one independent vote',()=>{
  const input=rows(['KPK OTT BNPB Jakarta Dana Bantuan','KPK OTT BNPB Jakarta Dana Bantuan Terbaru','BNPB Jakarta Dana Bantuan KPK OTT']).map((row,i)=>({...row,content_hash:`different-title-${i}`,lead:'KPK memeriksa sejumlah pihak terkait penggunaan dana bantuan di Jakarta. Pemeriksaan berlangsung sejak pagi dan keterangan resmi masih dikumpulkan oleh petugas yang mendalami aliran uang tersebut.'}));
  const event=run(input).events[0];assert.equal(event.independentGroupCount,1);assert.equal(event.syndicationCount,1);
});
test('stable identity is reused after representative changes',()=>{
  const input=rows(Array(3).fill('KPK OTT BNPB Jakarta Dana Bantuan'));
  const first=run(input).events[0];const identities=new Map(first.articles.map(a=>[a.id,first.id]));
  input[0].title='KPK OTT BNPB Jakarta Pengusutan Dana Bantuan';
  assert.equal(run(input,{identities}).events[0].id,first.id);
});
test('no input cap; older eligible sources remain processed',()=>{const input=rows(Array(15001).fill('KPK OTT BNPB Jakarta Dana Bantuan'));assert.equal(run(input).processedCount,15001);});
test('cohort changes and stale input are explicit',()=>{
  const run={as_of:now,cohort_version:'old',eligible_count:3,processed_count:3,health};
  assert.equal(availability(run,cohort,new Date(now).getTime()),'degraded');
  assert.equal(availability({...run,cohort_version:cohort.version},cohort,new Date(now).getTime()+31*60000),'stale');
});
test('promotion requires two reviewers, sample size and seven days',()=>{
  const report={reviewers:['A','B'],pairs:500,events:100,precision:.95,recall:.85,topTenUseful:8,shadowHours:168,inputComplete:true,sourceCoverageReviewed:true,algorithmVersion:'editorial-radar-v2'};
  assert(validateGate(report));assert(!validateGate({...report,shadowHours:167}));assert(!validateGate({...report,reviewers:['A','A']}));
});
test('official feeds retain publication date and reject lastmod-only or external URLs',()=>{
  const source={hosts:['news.test']};
  const xml='<rss><channel><item><title>Valid</title><link>https://news.test/valid</link><pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate></item><item><title>External</title><link>https://other.test/x</link><pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  assert.equal(parseFeed(xml,{source,channel:{id:'rss'}}).items.length,1);
  assert.equal(parseFeed('<urlset><url><loc>https://news.test/x</loc><lastmod>2026-10-14</lastmod></url></urlset>',{source,channel:{id:'sitemap'}}).items.length,0);
});
test('Google News sitemap metadata keeps its actual title and publication date',()=>{
  const xml='<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>https://news.test/x</loc><news:news><news:publication_date>2026-10-14T10:00:00Z</news:publication_date><news:title>Verified publication</news:title></news:news></url></urlset>';
  const result=parseFeed(xml,{source:{hosts:['news.test']},channel:{id:'sitemap'}});assert.equal(result.items.length,1);assert.equal(result.items[0].title_hint,'Verified publication');
});
test('live adapter failure rejects fixture fallback while explicit offline mode remains usable',async()=>{
  const axios=require('axios'),original=axios.get;axios.get=async()=>{throw new Error('local network probe disabled');};
  try {
    const adapter=require('../src/adapters').getAdapter('detik');
    await assert.rejects(adapter.discover({liveDiscover:true,fixtureOnly:false,limit:15,logger:{warn:()=>{}}}),/fixture fallback rejected/);
    assert((await adapter.discover({fixtureOnly:true,limit:15})).every(item=>item.channel==='fixture'));
  }finally{axios.get=original;}
});
test('paginated adapter discovery records continuation rather than complete input',async()=>{
  const writes=[];const db={query:async(sql,params)=>{writes.push({sql,params});return {rows:[]};}};
  const adapter={discover:async ctx=>[{url:`https://news.test/${ctx.page}`,title_hint:'Title',channel:'live',published_hint:now}]};
  const result=await discoverChannel({source:{id:'a',hosts:['news.test']},channel:{id:'index',kind:'adapter',pagination:{parameter:'page',step:1}},adapter,ctx:{overlapHours:24},db});
  assert.equal(result.items.length,20);assert.equal(result.complete,false);assert.equal(result.cursor.page,21);
});
test('blocked and transient HTTP outcomes are audited and fail the job',async()=>{
  for(const code of [403,429,503]) {
    const statuses=[],writes=[];
    await assert.rejects(handleFetch({data:{sourceId:'a',url:'https://news.test/x'},attemptsMade:0,opts:{attempts:3}},
      {fetch:async()=>({status:code,body:'',finalUrl:'https://news.test/x'}),setStatus:async s=>statuses.push(s.status),
        db:{query:async(sql,params)=>{writes.push(params);return {rows:[{fetch_id:1}]};}}}));
    assert.equal(writes.length,1);assert.equal(statuses.at(-1),code===403?'blocked':'retry_scheduled');
  }
});
test('successful fetch is cached once and referenced by parse job',async()=>{
  let fetched=0,cached=0;let payload;
  await handleFetch({data:{sourceId:'a',url:'https://news.test/x'},opts:{attempts:3}}, {
    fetch:async()=>{fetched++;return {status:200,body:'<p>News</p>',finalUrl:'https://news.test/x'};},
    setStatus:async()=>{},db:{query:async()=>({rows:[{fetch_id:42}]})},save:async()=>{cached++;},enqueueParse:async p=>{payload=p;},
  });assert.equal(fetched,1);assert.equal(cached,1);assert.equal(payload.fetchId,42);
});
test('parse consumes the cached HTML without a second HTTP fetch',async()=>{
  const {handleParse}=require('../src/workers/handlers/parse');let removed=0;
  const result=await handleParse({data:{sourceId:'a',url:'https://news.test/x',fetchId:42}}, {
    getAdapter:()=>({getSourceProfile:()=>({})}),readCache:async()=>({status:200,body:'cached HTML'}),removeCache:async()=>{removed++;},
    pipeline:async options=>{assert.equal((await options.fetchFn('https://news.test/x')).body,'cached HTML');return {status:'stored'};},
  });assert.equal(result.ok,true);assert.equal(removed,1);
});
test('expired cache schedules an explicitly audited fetch rather than parsing missing data',async()=>{
  const {handleParse}=require('../src/workers/handlers/parse');let requeued=0;const statuses=[];
  const result=await handleParse({data:{sourceId:'a',url:'https://news.test/x',fetchId:42}}, {
    getAdapter:()=>({}),readCache:async()=>null,setStatus:async s=>statuses.push(s),enqueueFetch:async()=>{requeued++;},
  });assert.equal(result.reason,'fetch_cache_expired');assert.equal(requeued,1);assert.equal(statuses[0].status,'retry_scheduled');
});
