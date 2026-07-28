#!/usr/bin/env node
'use strict';

require('dotenv').config();

if (process.env.EVENT_AGGREGATION_INTEGRATION !== 'true') {
  console.log(JSON.stringify({ skipped: true, reason: 'set EVENT_AGGREGATION_INTEGRATION=true to run against local Postgres' }));
  process.exit(0);
}

const pool = require('../src/db/pool');
const { getLatestCollectedAt, getAggregationArticles } = require('../src/db/newsEvents');

async function main() {
  const { rows } = await pool.query(`
    SELECT to_regclass('event_runs') AS event_runs,
           to_regclass('news_events') AS news_events,
           to_regclass('news_event_articles') AS news_event_articles
  `);
  const schema = rows[0];
  if (!schema.event_runs || !schema.news_events || !schema.news_event_articles) {
    throw new Error('S15 migration is not applied to the configured local database');
  }
  const latest = await getLatestCollectedAt();
  const articles = latest ? await getAggregationArticles({ cutoffAt: new Date(latest.getTime() - 24 * 3600 * 1000), maxArticles: 100 }) : [];
  console.log(JSON.stringify({ ok: true, schema, latestCollectedAt: latest, articleCount: articles.length }));
}

main().catch((error) => { console.error('[event-aggregation-integration] failed:', error.message); process.exitCode = 1; }).finally(() => pool.end());
