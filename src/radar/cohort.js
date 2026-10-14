'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Enrollment is explicit and independent of transient availability.
function loadCohort(env = process.env) {
  const file = env.RADAR_SOURCES_FILE || path.join(__dirname, '../../config/radar-sources.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sources = config.sources.slice().sort((a,b) => a.id.localeCompare(b.id));
  const seen = new Set();
  for (const source of sources) {
    if (!source.id || seen.has(source.id) || !source.group || !source.reason || !Array.isArray(source.channels) || typeof source.ownershipVerified!=='boolean') throw new Error('Invalid radar source configuration');
    seen.add(source.id);
    for (const channel of source.channels) {
      if (!channel.id || !['adapter','rss','sitemap'].includes(channel.kind)) throw new Error('Invalid radar channel');
      if (channel.kind !== 'adapter') {
        const url = new URL(channel.url);
        if (url.protocol !== 'https:' || !source.hosts.includes(url.hostname)) throw new Error('Channel must use an enrolled official HTTPS hostname');
      }
      if(channel.options?.channelUrl) {
        const url=new URL(channel.options.channelUrl);
        if(url.protocol!=='https:' || !source.hosts.includes(url.hostname))throw new Error('Adapter channel must use an enrolled official HTTPS hostname');
      }
    }
    if (source.active && !source.channels.length) throw new Error('Active radar source requires a validated channel');
  }
  return { version: crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex').slice(0,20), sources };
}
function enabled(env=process.env) { return env.RADAR_ENABLED === 'true'; }
function available(env=process.env) { return enabled(env) && env.RADAR_SERVE_CANDIDATE === 'true' && require('./gate').loadGate(env,loadCohort(env).version); }
module.exports = { loadCohort, enabled, available };
