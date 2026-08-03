#!/usr/bin/env node
'use strict';

require('dotenv').config();
const assert = require('assert');
const pool = require('../src/db/pool');
const { handleEventAggregation } = require('../src/workers/handlers/eventAggregation');
const { getLatestCollectedAt, getAggregationArticles, persistAggregationResult } = require('../src/db/newsEvents');

if (process.env.EVENT_AGGREGATION_PERSIST_INTEGRATION !== 'true') {
  console.log(JSON.stringify({ skipped: true, reason: 'set EVENT_AGGREGATION_PERSIST_INTEGRATION=true for local write/cleanup smoke' }));
  process.exit(0);
}

const sourceA = '__event_smoke_a';
const sourceB = '__event_smoke_b';
const articleIds = [];

async function cleanup() {
  await pool.query(
    `DELETE FROM event_runs
      WHERE run_id IN (SELECT DISTINCT run_id FROM news_event_articles WHERE source_id IN ($1, $2))
         OR run_key LIKE 'lexical-v1:24:%'`,
    [sourceA, sourceB]
  );
  await pool.query('DELETE FROM news_event_articles WHERE source_id IN ($1, $2)', [sourceA, sourceB]);
  if (articleIds.length) await pool.query('DELETE FROM articles WHERE article_id = ANY($1::bigint[])', [articleIds]);
  await pool.query('DELETE FROM articles WHERE source_id IN ($1, $2)', [sourceA, sourceB]);
  await pool.query('DELETE FROM sources WHERE source_id IN ($1, $2)', [sourceA, sourceB]);
}

async function main() {
  await cleanup();
  await pool.query(
    `INSERT INTO sources (source_id, display_name, base_url, adapter_version, timezone, crawl_interval_minutes, overlap_hours)
     VALUES ($1, $2, 'https://example.invalid', 'smoke', 'Asia/Jakarta', 60, 24),
            ($3, $4, 'https://example.invalid', 'smoke', 'Asia/Jakarta', 60, 24)`,
    [sourceA, 'Event Smoke A', sourceB, 'Event Smoke B']
  );
  const articleSql = `
    INSERT INTO articles
      (source_id, requested_url, final_url, canonical_url, normalized_url, title,
       content_text, first_discovered_at, collected_at, last_seen_at, content_hash,
       adapter_version, parser_version, validation_status, summary)
    VALUES ($1, $2, $2, $2, $2, $3, 'smoke body', $4, $4, $4, $5, 'smoke', 'smoke', 'valid', $6)
    RETURNING article_id`;
  for (const [sourceId, number] of [[sourceA, 1], [sourceB, 2]]) {
    const collected = new Date(Date.now() - number * 60_000).toISOString();
    const result = await pool.query(articleSql, [sourceId, `https://example.invalid/event-smoke/${number}`, number === 1 ? 'KPK Tangkap Arman dalam Korupsi Cakra' : 'Arman Ditangkap KPK Terkait Korupsi Cakra', collected, `smoke-hash-${number}`, 'KPK menangkap Arman dalam kasus Cakra']);
    articleIds.push(result.rows[0].article_id);
  }
  const config = { enabled: true, dryRun: false, windows: [24], algorithmVersion: 'lexical-v1', maxArticles: 10, batchSize: 10 };
  const deps = {
    config,
    getLatestCollectedAt: () => getLatestCollectedAt({ db: pool }),
    getAggregationArticles: (options) => getAggregationArticles({ ...options, db: pool }),
    persistAggregationResult: (result, options) => persistAggregationResult(result, { ...options, db: pool }),
  };
  const first = await handleEventAggregation({ data: { runKey: 'smoke-persist:first' } }, deps);
  const second = await handleEventAggregation({ data: { runKey: 'smoke-persist:second' } }, deps);
  assert.strictEqual(first.windows[0].persisted, true);
  assert.strictEqual(second.windows[0].persisted, true);
  const counts = await pool.query(`SELECT (SELECT COUNT(*) FROM event_runs WHERE run_key LIKE 'lexical-v1:24:%') AS runs, (SELECT COUNT(*) FROM news_events ne JOIN event_runs er ON er.run_id=ne.run_id WHERE er.run_key LIKE 'lexical-v1:24:%') AS events, (SELECT COUNT(*) FROM news_event_articles nea JOIN event_runs er ON er.run_id=nea.run_id WHERE er.run_key LIKE 'lexical-v1:24:%') AS members`);
  assert.strictEqual(Number(counts.rows[0].events), 1);
  assert.strictEqual(Number(counts.rows[0].members), 2);
  console.log(JSON.stringify({ ok: true, persisted: true, idempotent: true, events: Number(counts.rows[0].events), members: Number(counts.rows[0].members) }));
}

main().catch((error) => { console.error('[event-aggregation-persist] failed:', error.message); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } finally { await pool.end(); } });
