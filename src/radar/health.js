'use strict';
function comparableChannels(current,history,cohort,asOf,versionCreated) {
  const now=new Date(asOf).getTime(),cutoff=now-12*3600000;
  const stable=versionCreated && new Date(versionCreated).getTime()<=cutoff;
  const byChannel=new Map();
  for(const check of history) {
    const key=`${check.source_id}:${check.channel}`;
    if(!byChannel.has(key))byChannel.set(key,[]);byChannel.get(key).push(check);
  }
  return current.map(health=>{
    const source=cohort.sources.find(s=>s.id===health.source_id);
    const checks=byChannel.get(`${health.source_id}:${health.channel}`)||[];
    const previous=checks.filter(c=>new Date(c.attempted_at).getTime()<=cutoff).at(-1);
    const relevant=[...(previous?[previous]:[]),...checks.filter(c=>new Date(c.attempted_at).getTime()>cutoff)];
    const maxGap=(2*(source?.intervalMinutes||60)+10)*60000;
    const comparable=!!stable && !!previous && relevant.every((check,i)=>check.state==='healthy'&&check.complete&&
      (i===0 || new Date(check.attempted_at)-new Date(relevant[i-1].attempted_at)<=maxGap)) &&
      now-new Date(relevant.at(-1)?.attempted_at||0).getTime()<=maxGap;
    return {...health,comparable};
  });
}
module.exports={comparableChannels};
