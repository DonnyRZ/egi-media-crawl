'use strict';

const assert = require('assert');
const {
  DEFAULT_KEEP_RUNS,
  getEventAggregationConfig,
  parseBoundedInt,
} = require('../event-aggregation/config');
const {
  persistAggregationResult,
  expireOldEventRuns,
  countExpirableEventRuns,
  expirableRunsPredicate,
} = require('./newsEvents');

function sqlMentionsArticles(sql) {
  return /\barticles\b/i.test(String(sql));
}

async function testConfigKeepRuns() {
  const defaults = getEventAggregationConfig({});
  assert.strictEqual(defaults.keepRuns, DEFAULT_KEEP_RUNS);
  assert.strictEqual(defaults.retainBatchSize, 8);
  assert.strictEqual(getEventAggregationConfig({ EVENT_AGGREGATION_KEEP_RUNS: '2' }).keepRuns, 2);
  assert.strictEqual(parseBoundedInt('0', 3, 1, 100), 1);
  assert.strictEqual(parseBoundedInt('999', 3, 1, 100), 100);
}

async function testPredicateNeverTouchesArticles() {
  const predicate = expirableRunsPredicate({ windowHours: 72, keep: 3, protectRunIds: [42, 42, 'nope'] });
  assert.strictEqual(predicate.params[0], 72);
  assert.deepStrictEqual(predicate.params[1], [42]);
  assert.strictEqual(predicate.params[2], 3);
  assert.strictEqual(sqlMentionsArticles(predicate.sql), false);
  assert.match(predicate.sql, /FROM event_runs/);
  assert.doesNotMatch(predicate.sql, /DELETE FROM news_event_articles/);
}

async function testExpireDryRunSelectsEventRunsOnly() {
  const statements = [];
  const db = {
    query: async (sql, params) => {
      statements.push({ sql, params });
      return { rows: [{ run_id: 11 }, { run_id: 12 }] };
    },
  };
  const result = await expireOldEventRuns({
    windowHours: 24,
    keep: 3,
    batchSize: 8,
    protectRunIds: [99],
    dryRun: true,
    db,
  });
  assert.strictEqual(result.deleted, 0);
  assert.strictEqual(result.candidateCount, 2);
  assert.deepStrictEqual(result.runIds, [11, 12]);
  assert.strictEqual(statements.length, 1);
  assert.strictEqual(sqlMentionsArticles(statements[0].sql), false);
  assert.match(statements[0].sql, /SELECT run_id/);
  assert.doesNotMatch(statements[0].sql, /DELETE FROM/);
  assert.strictEqual(statements[0].params[0], 24);
  assert.deepStrictEqual(statements[0].params[1], [99]);
  assert.strictEqual(statements[0].params[2], 3);
  assert.strictEqual(statements[0].params[3], 8);
}

async function testExpireDeletesEventRunsBatch() {
  const statements = [];
  const db = {
    query: async (sql, params) => {
      statements.push({ sql, params });
      if (/SELECT run_id/.test(sql)) return { rows: [{ run_id: 7 }, { run_id: 8 }] };
      if (/DELETE FROM event_runs/.test(sql)) return { rows: [{ run_id: 7 }, { run_id: 8 }], rowCount: 2 };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const result = await expireOldEventRuns({ windowHours: 168, keep: 2, batchSize: 5, db });
  assert.strictEqual(result.deleted, 2);
  assert.deepStrictEqual(result.runIds, [7, 8]);
  assert.strictEqual(statements[1].sql.includes('DELETE FROM event_runs'), true);
  assert.strictEqual(sqlMentionsArticles(statements.map((item) => item.sql).join('\n')), false);
}

async function testCountExpirable() {
  const db = {
    query: async (sql, params) => {
      assert.strictEqual(sqlMentionsArticles(sql), false);
      assert.match(sql, /COUNT\(\*\)/);
      assert.strictEqual(params[0], 24);
      return { rows: [{ count: 2045 }] };
    },
  };
  const count = await countExpirableEventRuns({ windowHours: 24, keep: 3, db });
  assert.strictEqual(count, 2045);
}

function createRecordingDb() {
  const statements = [];
  const client = {
    query: async (sql, params) => {
      statements.push({ source: 'client', sql: String(sql).trim(), params });
      if (/^BEGIN/i.test(sql.trim())) return { rows: [] };
      if (/INSERT INTO event_runs/i.test(sql)) return { rows: [{ run_id: 501 }] };
      if (/DELETE FROM news_events/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO news_events/i.test(sql)) return { rows: [{ event_id: 9 }] };
      if (/INSERT INTO news_event_articles/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE event_runs/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/^COMMIT/i.test(sql.trim())) return { rows: [] };
      if (/^ROLLBACK/i.test(sql.trim())) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {
      statements.push({ source: 'client', sql: 'RELEASE' });
    },
  };
  return {
    statements,
    connect: async () => client,
    query: async (sql, params) => {
      statements.push({ source: 'pool', sql: String(sql).trim(), params });
      if (/SELECT run_id/.test(sql)) return { rows: [{ run_id: 1 }] };
      if (/DELETE FROM event_runs/.test(sql)) return { rows: [{ run_id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const sampleResult = {
  algorithm_version: 'lexical-v1',
  window_hours: 24,
  anchor_at: '2026-08-26T10:00:00.000Z',
  cutoff_at: '2026-08-25T10:00:00.000Z',
  article_count: 2,
  candidate_count: 1,
  event_count: 1,
  events: [{
    representative_title: 'KPK Tangkap Arman',
    anchor_terms: ['kpk', 'arman'],
    article_count: 2,
    media_count: 2,
    coverage_score: 21,
    first_seen_at: '2026-08-26T09:00:00.000Z',
    last_seen_at: '2026-08-26T10:00:00.000Z',
    algorithm_version: 'lexical-v1',
    articles: [{
      article_id: 1,
      source_id: 'detik',
      match_score: 1,
      match_reason: { seed: true },
    }],
  }],
};

async function testPersistRetainsAfterCommit() {
  const db = createRecordingDb();
  const persisted = await persistAggregationResult(sampleResult, {
    dryRun: false,
    config: { keepRuns: 3, retainBatchSize: 8 },
    db,
  });
  assert.strictEqual(persisted.persisted, true);
  assert.strictEqual(persisted.runId, 501);
  assert.strictEqual(persisted.retained.deleted, 1);
  const sql = db.statements.map((item) => item.sql);
  const commitAt = sql.findIndex((item) => item === 'COMMIT');
  const releaseAt = sql.findIndex((item) => item === 'RELEASE');
  const retainSelectAt = sql.findIndex((item, index) => index > releaseAt && /SELECT run_id/.test(item));
  const retainDeleteAt = sql.findIndex((item, index) => index > retainSelectAt && /DELETE FROM event_runs/.test(item));
  assert.ok(commitAt >= 0, 'expected COMMIT');
  assert.ok(releaseAt > commitAt, 'client must be released after COMMIT');
  assert.ok(retainSelectAt > releaseAt, 'retain must run after client release');
  assert.ok(retainDeleteAt > retainSelectAt, 'delete batch must follow candidate select');
  assert.strictEqual(db.statements[retainSelectAt].source, 'pool');
  assert.deepStrictEqual(db.statements[retainSelectAt].params[1], [501]);
  assert.strictEqual(db.statements[retainSelectAt].params[2], 3);
  assert.strictEqual(sqlMentionsArticles(sql.join('\n')), false);
  assert.doesNotMatch(sql.join('\n'), /DELETE FROM articles/i);
}

async function testRetainFailureDoesNotThrow() {
  const db = createRecordingDb();
  db.query = async () => {
    throw new Error('retain boom');
  };
  const persisted = await persistAggregationResult(sampleResult, {
    config: { keepRuns: 3, retainBatchSize: 8 },
    db,
  });
  assert.strictEqual(persisted.persisted, true);
  assert.strictEqual(persisted.retained, false);
  assert.strictEqual(persisted.retainError, 'retain boom');
}

async function main() {
  await testConfigKeepRuns();
  await testPredicateNeverTouchesArticles();
  await testExpireDryRunSelectsEventRunsOnly();
  await testExpireDeletesEventRunsBatch();
  await testCountExpirable();
  await testPersistRetainsAfterCommit();
  await testRetainFailureDoesNotThrow();
  console.log(JSON.stringify({ ok: true, keepRuns: DEFAULT_KEEP_RUNS, retainAfterCommit: true, articlesUntouched: true }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
