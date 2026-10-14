'use strict';
const crypto=require('node:crypto');
const {getConnection}=require('../../queue/connection');
function key(source,url,id) {return `crawl-html-${crypto.createHash('sha256').update(`${source}|${url}|${id}`).digest('hex')}`;}
async function save(source,url,id,result,redis=getConnection()) {
  if(Buffer.byteLength(result.body||'')>4*1024*1024)throw new Error('Article exceeds 4MiB fetch cache budget');
  await redis.set(key(source,url,id),JSON.stringify(result),'EX',3600);
}
async function read(source,url,id,redis=getConnection()) {const raw=await redis.get(key(source,url,id));return raw?JSON.parse(raw):null;}
async function remove(source,url,id,redis=getConnection()) {await redis.del(key(source,url,id));}
module.exports={key,save,read,remove};
