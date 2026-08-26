#!/usr/bin/env node
'use strict';

if (process.env.EVENT_AGGREGATION_PERSIST_INTEGRATION !== 'true') {
  console.log(JSON.stringify({ skipped: true, reason: 'set EVENT_AGGREGATION_PERSIST_INTEGRATION=true for local write/cleanup retain smoke' }));
  process.exit(0);
}

require('dotenv').config();
const assert = require('assert');
const pool = require('../src/db/pool');
const { expireOldEventRuns, countExpirableEventRuns } = require('../src/db/newsEvents');

const PREFIX = 'retain-smoke:24:';

async function articleCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::bigint AS count FROM articles');
  return Number(rows[0].count);
}

async function cleanup() {
  await pool.query('DELETE FROM event_runs WHERE run_key LIKE $1', [`${PREFIX}%`]);
}

async function main() {
  await cleanup();
  const foreign = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM event_runs
      WHERE window_hours = 24
        AND run_key NOT LIKE $1`,
    [`${PREFIX}%`]
  );
  if (Number(foreign.rows[0].count) > 0) {
    console.log(JSON.stringify({
      skipped: true,
      reason: 'window 24 already has non-smoke event_runs; refuse to expire a shared window',
    }));
    return;
  }
  const articlesBefore = await articleCount();
  const now = Date.now();
  for (let index = 0; index < 5; index += 1) {
    const stamp = new Date(now - (5 - index) * 60_000).toISOString();
    await pool.query(
      `INSERT INTO event_runs
         (run_key, window_hours, algorithm_version, anchor_at, cutoff_at,
          status, article_count, candidate_count, event_count, finished_at)
       VALUES ($1, 24, 'lexical-v1', $2, $2, 'succeeded', 0, 0, 0, $2)`,
      [`${PREFIX}${index}`, stamp]
    );
  }
  const expirable = await countExpirableEventRuns({ windowHours: 24, keep: 3, db: pool });
  assert.ok(expirable >= 2, `expected at least 2 expirable runs, got ${expirable}`);
  const expired = await expireOldEventRuns({ windowHours: 24, keep: 3, batchSize: 10, db: pool });
  assert.ok(expired.deleted >= 2);
  const remaining = await pool.query(
    'SELECT COUNT(*)::int AS count FROM event_runs WHERE run_key LIKE $1',
    [`${PREFIX}%`]
  );
  assert.strictEqual(Number(remaining.rows[0].count), 3);
  const articlesAfter = await articleCount();
  assert.strictEqual(articlesAfter, articlesBefore);
  console.log(JSON.stringify({
    ok: true,
    deleted: expired.deleted,
    remaining: Number(remaining.rows[0].count),
    articlesUnchanged: true,
  }));
}

main()
  .catch((error) => {
    console.error('[event-aggregation-retain-smoke] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanup(); } finally { await pool.end(); }
  });
