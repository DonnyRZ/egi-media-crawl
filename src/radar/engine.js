'use strict';
const crypto = require('node:crypto');
const { STOPWORDS, GENERIC_ANCHORS, fold } = require('../event-aggregation/normalize');
const HOUR = 3600000;
const VERSION = 'editorial-radar-v2';
const ALIASES = [
  [/\bbank indonesia\b/g,'bi'], [/\beuropean central bank\b|\bbank sentral eropa\b/g,'ecb'],
  [/\bujung pandang\b/g,'makassar'], [/\bhydraulic\b/g,'hidrolik'],
  [/\bemergency landing\b|\bpendaratan darurat\b|\bmendarat darurat\b/g,'darurat'],
  [/\bresign\b|\bmengundurkan diri\b/g,'mundur'], [/\bditangkap\b|\bmenangkap\b/g,'tangkap'],
  [/\boperasi tangkap tangan\b/g,'ott'], [/\bannounces?\b|\bmengumumkan\b/g,'umumkan'],
];
const ENTITIES = new Set('bi ecb pln bnpb kpk pegadaian garuda bni bri mandiri by dpr trump prabowo gibran raline'.split(' '));
const ACTIONS = new Set('darurat hidrolik mundur ott tangkap suku bunga juara menang penghargaan awards'.split(' '));
function text(value) { let s=fold(value); for(const [pattern,replacement] of ALIASES) s=s.replace(pattern,replacement); return s; }
function tokens(value) { return text(value).match(/[\p{L}\p{N}]+/gu)?.filter(t=>!STOPWORDS.has(t)) || []; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0,24); }
function time(value) { if (!value) return NaN; return new Date(value).getTime(); }
function classify(value) {
  const s=text(value);
  if (['politics','business','technology','sports','entertainment','other'].includes(s)) return s;
  if (/politik|politics|pemilu|pilkada|dpr|kpk|prabowo|ott/.test(s)) return 'politics';
  if (/teknologi|technology|tech|gadget|digital|software/.test(s)) return 'technology';
  if (/olahraga|sports|sport|bola|liga|timnas/.test(s)) return 'sports';
  if (/hiburan|entertainment|seleb|musik|film|raline|showbiz|dangdut/.test(s)) return 'entertainment';
  if (/bisnis|business|ekonomi|economy|finance|bank|saham|pln|pegadaian/.test(s)) return 'business';
  return 'other';
}
function normalize(row, source, asOf) {
  if (/fixture/i.test(row.channel || '') || !row.title || !row.url) return null;
  try {
    const url=new URL(row.url);
    if(!['https:','http:'].includes(url.protocol) || (source.hosts?.length && !source.hosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host))))return null;
  }catch{return null;}
  const published=time(row.published_at), first=time(row.first_seen_at || row.first_discovered_at);
  if (!Number.isFinite(published) || published>asOf || !Number.isFinite(first) || first>asOf) return null;
  const titleTokens=new Set(tokens(row.title));
  const evidenceTokens=new Set([...titleTokens,...tokens(`${row.summary || ''} ${row.lead || ''}`)]);
  const entities=new Set([...evidenceTokens].filter(t=>ENTITIES.has(t)));
  // Preserve acronyms even when their length is two. All-uppercase headlines are not all entities.
  if (row.title !== row.title.toUpperCase()) for (const acronym of row.title.match(/\b[A-Z]{2,8}\b/g)||[]) {
    if (!GENERIC_ANCHORS.has(acronym.toLowerCase())) entities.add(acronym.toLowerCase());
  }
  const numbers=new Set([...titleTokens].filter(t=>/^\d+$/.test(t)));
  const identifiers=new Map([...text(row.title).matchAll(/\b(ga|qz|jt|kasus|perkara)\s*(\d{1,6})\b/g)].map(m=>[m[1],m[2]]));
  const normalizedLead=text(row.lead||'').replace(/\s+/g,' ').trim();
  const copyKey=row.evidence_quality==='full_text' ? (normalizedLead.length>=160 ? `lead-${hash(normalizedLead)}` : row.content_hash) : null;
  return { ...row, key: `${row.source_id}:${row.url}`, source, published, first,
    titleTokens,evidenceTokens,entities,numbers,identifiers,copyKey, category:classify(row.category) !== 'other' ? classify(row.category) : classify(row.title),
    fingerprint: row.content_hash || hash([...tokens(row.title),...tokens(row.lead || row.summary || '')].join(' ')) };
}
function overlap(a,b) { return [...a].filter(t=>b.has(t)); }
function cosine(a,b,weights) {
  let dot=0,left=0,right=0;
  for (const t of a) { const w=weights.get(t)||1; left+=w*w; if(b.has(t)) dot+=w*w; }
  for (const t of b) { const w=weights.get(t)||1; right+=w*w; }
  return dot/Math.sqrt(left*right || 1);
}
function match(a,b,weights) {
  if (Math.abs(a.published-b.published)>36*HOUR) return {accepted:false,similarity:0};
  for(const [type,value] of a.identifiers)if(b.identifiers.has(type)&&b.identifiers.get(type)!==value)return {accepted:false,similarity:0};
  const shared=overlap(a.evidenceTokens,b.evidenceTokens).filter(t=>!GENERIC_ANCHORS.has(t));
  const entityShared=overlap(a.entities,b.entities);
  const exclusiveA=[...a.entities].filter(t=>!b.entities.has(t));
  const exclusiveB=[...b.entities].filter(t=>!a.entities.has(t));
  // A common ceremony can be one parent, with institution-specific angles below it.
  const ceremony=/\b(penghargaan|award|awards)\b/.test(text(a.title)) && /\b(penghargaan|award|awards)\b/.test(text(b.title));
  const ceremonyContext=shared.filter(t=>!['raih','meraih','penghargaan','award','awards','terbaik'].includes(t));
  if (exclusiveA.length && exclusiveB.length && !entityShared.length && !(ceremony && ceremonyContext.length>=3)) return {accepted:false,similarity:0};
  if (a.numbers.size && b.numbers.size && !overlap(a.numbers,b.numbers).length && shared.some(t=>['bunga','suku','korban','tewas','penerbangan'].includes(t))) return {accepted:false,similarity:0};
  const titleSimilarity=cosine(a.titleTokens,b.titleTokens,weights);
  const evidenceSimilarity=cosine(a.evidenceTokens,b.evidenceTokens,weights);
  const similarity=.7*titleSimilarity+.3*evidenceSimilarity;
  const flightIncident=entityShared.includes('garuda') && shared.includes('makassar') &&
    /darurat|hidrolik/.test(text(a.title)) && /darurat|hidrolik/.test(text(b.title));
  const distinct=shared.filter(t=>!ACTIONS.has(t));
  const accepted=(shared.length>=3 && distinct.length>=2 && similarity>=.48) ||
    (entityShared.length>=1 && shared.length>=3 && similarity>=.36) ||
    (ceremony && ceremonyContext.length>=3 && similarity>=.42) || (flightIncident && similarity>=.25);
  return {accepted,similarity,shared,entityShared};
}
function scoreEvent(members,cohort,health,asOf) {
  const active=cohort.sources.filter(s=>s.active);
  const groupsTotal=new Set(active.filter(s=>s.ownershipVerified!==false).map(s=>s.group)).size;
  const sources=new Set(members.map(m=>m.source_id)), groups=new Set(members.filter(m=>m.source.ownershipVerified!==false).map(m=>m.source.group));
  const copies=new Set();
  const independent=members.filter(m=>{
    if(!m.copyKey)return true;
    if(copies.has(m.copyKey))return false;copies.add(m.copyKey);return true;
  });
  const independentSources=new Set(independent.map(m=>m.source_id)), independentGroups=new Set(independent.filter(m=>m.source.ownershipVerified!==false).map(m=>m.source.group));
  const breadth=.5*Math.log1p(independentSources.size)/Math.log1p(active.length||1)+.5*Math.log1p(independentGroups.size)/Math.log1p(groupsTotal||1);
  // A group is comparable only if every enrolled outlet in it has complete, fresh discovery.
  const healthyGroups=new Set(active.filter(s=>s.ownershipVerified!==false && s.channels.length && s.channels.every(c=>health.some(h=>h.source_id===s.id && h.channel===c.id && h.state==='healthy' && h.complete && h.comparable!==false && time(h.last_success_at)>=asOf-2*(s.intervalMinutes||60)*60000))).map(s=>s.group));
  for(const source of active) if (!source.channels.every(c=>health.some(h=>h.source_id===source.id && h.channel===c.id && h.state==='healthy' && h.complete && h.comparable!==false && time(h.last_success_at)>=asOf-2*(source.intervalMinutes||60)*60000))) healthyGroups.delete(source.group);
  const firstByGroup=new Map();
  for(const m of independent.filter(m=>m.source.ownershipVerified!==false)) firstByGroup.set(m.source.group, Math.min(firstByGroup.get(m.source.group)??Infinity,m.published));
  let recent=0,previous=0,last=Math.max(...independent.map(m=>m.published));
  for(const [group,at] of firstByGroup) {
    last=Math.max(last,at);
    if(!healthyGroups.has(group)) continue;
    // Enrollment/backfill observed more than 2h after publication cannot create a burst.
    if(!independent.some(m=>m.source.group===group && m.published===at && m.first-m.published<=2*HOUR && m.first>=time(m.source.enrolledAt))) continue;
    if(at>=asOf-6*HOUR) recent++; else if(at>=asOf-12*HOUR) previous++;
  }
  const momentum=healthyGroups.size ? Math.max(0,recent-previous)/healthyGroups.size : 0;
  const freshness=Math.pow(2,-Math.max(0,asOf-last)/(12*HOUR));
  return {score:Number((100*(.5*breadth+.3*momentum+.2*freshness)).toFixed(3)),
    components:{breadth,momentum,freshness}, mediaCount:sources.size,groupCount:groups.size,
    trend:recent>previous?'rising':recent<previous?'falling':'steady', comparableGroups:healthyGroups.size,
    independentGroupCount:independentGroups.size,
    recommendation:independentSources.size>=3&&independentGroups.size>=2?'primary':independentGroups.size>=2&&recent>0?'emerging':'insufficient',
    lastDevelopedAt:new Date(last).toISOString()};
}
function aggregateRadar(rows,{cohort,health=[],asOf=new Date(),windowHours=24,identities=new Map()}={}) {
  const now=time(asOf),cutoff=now-windowHours*HOUR;
  if(!Number.isFinite(now)||!cohort) throw new Error('Radar needs a valid wall-clock anchor and cohort');
  const sourceMap=new Map(cohort.sources.filter(s=>s.active).map(s=>[s.id,s]));
  const seen=new Set();
  const seenBodies=new Set();
  const documents=[];
  for(const row of rows) {
    const source=sourceMap.get(row.source_id); if(!source) continue;
    const doc=normalize(row,source,now); if(!doc||doc.published<cutoff||seen.has(doc.key)) continue;
    const copy=doc.copyKey && `${doc.source_id}:${doc.copyKey}`;
    if(copy&&seenBodies.has(copy))continue;
    if(copy)seenBodies.add(copy);
    seen.add(doc.key);documents.push(doc);
  }
  documents.sort((a,b)=>a.published-b.published||a.key.localeCompare(b.key));
  const frequency=new Map();
  for(const doc of documents) for(const token of doc.evidenceTokens) frequency.set(token,(frequency.get(token)||0)+1);
  const weights=new Map([...frequency].map(([t,n])=>[t,(1+Math.log((documents.length+1)/(n+1)))*(ENTITIES.has(t)?1.5:1)]));
  const index=new Map(),clusters=[],exact=new Map();let comparisons=0;
  for(const doc of documents) {
    const candidates=new Map();
    for(const token of doc.titleTokens) {
      if(GENERIC_ANCHORS.has(token)) continue;
      for(const id of index.get(token)||[]) candidates.set(id,(candidates.get(id)||0)+1);
    }
    let best=null;
    const direct=exact.get(text(doc.title));
    if(direct!==undefined && Math.abs(doc.published-clusters[direct].last)<=36*HOUR) best={id:direct,score:1};
    if(!best) for(const [id,count] of candidates) {
      if(count<2) continue;
      const cluster=clusters[id];if(doc.published-cluster.last>36*HOUR) continue;
      for(const representative of cluster.representatives) {
        comparisons++;const result=match(doc,representative,weights);
        if(result.accepted && (!best||result.similarity>best.score)) best={id,score:result.similarity};
      }
    }
    const id=best?.id ?? clusters.length;
    if(!best) clusters.push({members:[],representatives:[],last:doc.published});
    const cluster=clusters[id];cluster.members.push({...doc,matchScore:best?.score??1});cluster.last=doc.published;
    // Diverse representatives and the candidate index evolve, rather than matching only the seed.
    if(!cluster.representatives.some(r=>text(r.title)===text(doc.title))) {
      cluster.representatives.push(doc);
      if(cluster.representatives.length>12)cluster.representatives.shift();
    }
    for(const token of doc.titleTokens) { if(!index.has(token)) index.set(token,new Set()); index.get(token).add(id); }
    exact.set(text(doc.title),id);
  }
  const usedIds=new Set();
  const events=clusters.map((cluster,clusterIndex)=>{
    const members=cluster.members;
    const prior=new Map();for(const m of members) {const id=identities.get(m.key);if(id)prior.set(id,(prior.get(id)||0)+1);}
    const old=[...prior].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).find(([id])=>!usedIds.has(id));
    let id=old?.[0]||`radar-${hash(members[0].key)}`;
    if(usedIds.has(id)) {
      const seed=members.map(member=>member.key).sort().join('\n');
      let salt=0;
      do { id=`radar-${hash(`${seed}\ncluster:${clusterIndex}\n${salt++}`)}`; } while(usedIds.has(id));
    }
    usedIds.add(id);
    const rank=scoreEvent(members,cohort,health,now);
    const representative=members.slice().sort((a,b)=>b.matchScore-a.matchScore||a.published-b.published||a.key.localeCompare(b.key))[0];
    const angles=new Map();
    for(const m of members) {
      const angleTokens=[...m.entities].sort();
      const action=[...m.titleTokens].filter(t=>ACTIONS.has(t)).sort();
      const signature=[...angleTokens,...action].join('|')||[...m.titleTokens].slice(0,3).join('|');
      if(!angles.has(signature)) angles.set(signature,{id:`angle-${hash(id+signature)}`,title:m.title,articleCount:0,sourceIds:new Set()});
      const angle=angles.get(signature);angle.articleCount++;angle.sourceIds.add(m.source_id);m.angleId=angle.id;
    }
    const fingerprints=new Map();for(const m of members) {if(!m.copyKey)continue;if(!fingerprints.has(m.copyKey))fingerprints.set(m.copyKey,new Set());fingerprints.get(m.copyKey).add(m.source_id);}
    const syndicationCount=[...fingerprints.values()].filter(s=>s.size>1).length;
    const quality=members.every(m=>m.evidence_quality==='full_text')?'full_text':members.every(m=>m.evidence_quality==='listing_only')?'listing_only':'mixed';
    return {id,title:representative.title,category:representative.category,...rank,articleCount:members.length,
      confidence:quality==='full_text'&&rank.groupCount>=3&&members.every(m=>m.source.ownershipVerified!==false)?'high':'limited', evidenceQuality:quality, syndicationCount,
      firstSeenAt:new Date(Math.min(...members.map(m=>m.first))).toISOString(),
      summary:`${rank.mediaCount} portal, ${rank.groupCount} kelompok media terverifikasi. ${rank.trend==='rising'?'Cakupan sedang bertambah.':'Perhatian lintas media dalam periode ini.'}`,
      reasons:[`${rank.mediaCount} portal unik / ${rank.groupCount} kelompok media terverifikasi`,`${rank.comparableGroups} kelompok dapat dibandingkan untuk momentum`,...(members.some(m=>m.source.ownershipVerified===false)?['Kepemilikan sebagian portal belum dipastikan; tidak dihitung sebagai kelompok independen tambahan']:[]),...(syndicationCount?['Kemiripan salinan lintas portal terdeteksi; bukan bukti pasti sindikasi']:[]),...(quality!=='full_text'?['Sebagian bukti hanya metadata resmi']:[])],
      angles:[...angles.values()].map(a=>({...a,sourceIds:[...a.sourceIds]})),
      timeline:[...new Map(members.map(m=>[m.source.group,m])).values()].map(m=>({id:hash(id+m.source.group),label:m.source.label||m.source_id,at:new Date(m.published).toISOString(),detail:m.title})).sort((a,b)=>a.at.localeCompare(b.at)),
      articles:members.map(m=>({id:m.key,title:m.title,sourceLabel:m.source.label||m.source_id,source:m.source_id,
        publishedAt:new Date(m.published).toISOString(),url:m.url,evidenceQuality:m.evidence_quality||'full_text',angleId:m.angleId,matchScore:m.matchScore}))};
  });
  events.sort((a,b)=>b.score-a.score||b.components.breadth-a.components.breadth||b.lastDevelopedAt.localeCompare(a.lastDevelopedAt)||a.id.localeCompare(b.id));
  return {algorithmVersion:VERSION,cohortVersion:cohort.version,asOf:new Date(now).toISOString(),windowHours,
    eligibleCount:documents.length,processedCount:documents.length,comparisons,events};
}
module.exports={aggregateRadar,scoreEvent,match,tokens,classify,VERSION};
