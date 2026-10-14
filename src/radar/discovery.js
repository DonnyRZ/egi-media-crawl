'use strict';
const axios=require('axios');
const cheerio=require('cheerio');
const {parseListingDateIso}=require('../core/parseListingDate');
const {loadCohort}=require('./cohort');
const {recordHealth}=require('./store');
function official(url,source) {
  try {const u=new URL(url);return u.protocol==='https:' && source.hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));}catch{return false;}
}
function parseFeed(body,{source,channel}) {
  const $=cheerio.load(body,{xmlMode:true});const items=[],next=[];
  if(!$('rss, feed, urlset, sitemapindex').length)throw new Error('unrecognized_official_feed');
  $('item, entry, url').each((_,el)=>{
    const node=$(el);
    const url=node.find('loc').first().text().trim()||node.find('link').first().text().trim()||node.find('link[rel="alternate"]').attr('href');
    const title=node.find('title, news\\:title').first().text().trim();
    // lastmod can indicate recrawling/editing: it is deliberately NOT a publication date.
    const raw=node.find('pubDate, published, news\\:publication_date').first().text().trim();
    const date=parseListingDateIso(raw);
    if(url&&title&&date&&official(url,source))items.push({url,title_hint:title,published_hint:date,channel:channel.id});
  });
  $('sitemap loc, link[rel="next"]').each((_,el)=>{
    const u=$(el).attr('href')||$(el).text().trim();if(official(u,source))next.push(u);
  });
  return {items,next};
}
async function discoverChannel({source,channel,adapter,ctx,db,fetch=axios.get}) {
  const state=await db.query('SELECT * FROM radar_source_health WHERE source_id=$1 AND channel=$2',[source.id,channel.id]);
  const previous=state.rows[0];
  const cutoff=previous?.watermark_at?new Date(new Date(previous.watermark_at).getTime()-2*3600000):new Date(Date.now()-(ctx.overlapHours||24)*3600000);
  const budget=5000;let items=[],complete=false,cursor={},reason=null,pendingUrls=[],visitedPages=[];
  try {
    if(channel.kind==='adapter') {
      // Each adapter keeps its own validated pagination convention. Raise discovery capacity,
      // not the fetch batch. Saturation stays visible rather than pretending a complete crawl.
      const pagination=channel.pagination;
      let page=previous?.cursor?.page||1;
      const seen=new Set();let exhausted=false, crossed=false;
      for(let requests=0;requests<(pagination?20:1);requests++) {
        const options={...ctx,...channel.options,limit:pagination?200:budget,overlapCutoffAt:cutoff.toISOString(),fixtureOnly:false,liveDiscover:true};
        const head=requests===0 && page>1;
        const requestedPage=head?1:page;
        if(pagination)options[pagination.parameter]=pagination.parameter==='offset'?(requestedPage-1)*pagination.step:requestedPage;
        let batch;
        try {batch=await adapter.discover(options);} catch(error) {
          if(!items.length)throw error;
          reason=error.message;break; // Keep the successful earlier pages visible and retry the failed cursor.
        }
        if(batch.some(item=>/fixture/i.test(item.channel||'')))throw new Error('live_fixture_rejected');
        const newItems=batch.filter(item=>official(item.url,source)&&!seen.has(item.metadata?.normalizedUrlHint||item.url));
        if(!newItems.length){reason='pagination_exhaustion_not_verified';exhausted=batch.complete===true;break;}
        for(const item of newItems)seen.add(item.metadata?.normalizedUrlHint||item.url);
        items.push(...newItems);
        crossed=batch.some(item=>item.published_hint&&new Date(item.published_hint)<=cutoff);
        if(crossed||batch.complete===true){exhausted=true;break;}
        if(batch.partialFailure)reason=batch.partialFailure;
        if(!head)page++;
        if(!pagination||items.length>=budget)break;
      }
      cursor=pagination&&!exhausted?{page}:{};
      if(items.some(item=>/fixture/i.test(item.channel||'')))throw new Error('live_fixture_rejected');
      items=items.filter(item=>official(item.url,source));
      // Adapter arrays do not prove pagination exhaustion. Only verified adapter evidence
      // (or crossing a dated watermark) may mark the channel complete.
      complete=exhausted;
      reason=complete?null:reason||(pagination?'continuation_pending':'adapter_exhaustion_not_verified');
    } else {
      pendingUrls=[...(previous?.cursor?.pending||[channel.url])];
      const pending=pendingUrls,visited=new Set(previous?.cursor?.visited||[]);
      if(previous?.cursor?.pending?.length){visited.delete(channel.url);pending.unshift(channel.url);}
      let pages=0;
      while(pending.length&&pages<20&&items.length<budget) {
        const url=pending.shift();if(visited.has(url))continue;visited.add(url);pages++;
        let response;
        try{response=await fetch(url,{timeout:15000,headers:{'User-Agent':'EGIMediaCrawler/0.1'},maxRedirects:0,validateStatus:()=>true,responseType:'text'});}
        catch(error){pending.unshift(url);visited.delete(url);throw error;}
        if(response.status!==200){pending.unshift(url);visited.delete(url);throw Object.assign(new Error(`listing_http_${response.status}`),{httpStatus:response.status});}
        let parsed;
        try{parsed=parseFeed(response.data,{source,channel});}
        catch(error){pending.unshift(url);visited.delete(url);throw error;}
        visitedPages=[...visited];
        items.push(...parsed.items.filter(item=>new Date(item.published_hint)>=cutoff));
        pending.push(...parsed.next.filter(url=>!visited.has(url)&&!pending.includes(url)));
      }
      visitedPages=[...visited];
      complete=!pending.length;cursor=complete?{}:{pending,visited:visitedPages};reason=complete?null:'continuation_pending';
      if(!items.length&&pages===1&&!complete)reason='empty_listing';
    }
    const validDates=items.map(i=>new Date(i.published_hint).getTime()).filter(Number.isFinite);
    const candidateWatermark=Math.max(previous?.cursor?.watermark ? new Date(previous.cursor.watermark).getTime() : 0,...validDates);
    if(!complete&&candidateWatermark)cursor.watermark=new Date(candidateWatermark).toISOString();
    await recordHealth({sourceId:source.id,channel:channel.id,state:reason?'degraded':'healthy',reason,count:items.length,complete,
      watermark:candidateWatermark?new Date(candidateWatermark):null,cursor},db);
    return {items:items.map(item=>({...item,radar_category:channel.desks?.length===1?channel.desks[0]:undefined})),complete,cursor};
  }catch(error) {
    cursor=pendingUrls.length?{pending:pendingUrls,visited:visitedPages}:previous?.cursor||{};
    await recordHealth({sourceId:source.id,channel:channel.id,state:error.httpStatus===403?'blocked':'failed',reason:error.message,count:items.length,complete:false,cursor},db);
    if(items.length)return {items:items.map(item=>({...item,radar_category:channel.desks?.length===1?channel.desks[0]:undefined})),complete:false,cursor};
    throw error;
  }
}
async function discoverRadar({sourceId,adapter,ctx,db}) {
  const source=loadCohort().sources.find(s=>s.id===sourceId);
  if(!source?.active)return {items:[],skipped:true};
  const items=[],failures=[];
  for(const channel of source.channels)try {const result=await discoverChannel({source,channel,adapter,ctx,db});items.push(...result.items);}catch(error){failures.push(error.message);}
  if(failures.length===source.channels.length)throw new Error(`All active discovery channels failed: ${failures.join('; ')}`);
  return {items,failures};
}
module.exports={official,parseFeed,discoverChannel,discoverRadar};
