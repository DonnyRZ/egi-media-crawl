'use strict';

const {
  DEFAULT_KEEP_RUNS,
  DEFAULT_RETAIN_BATCH_SIZE,
  parseBoundedInt,
} = require('../event-aggregation/config');

function defaultPool() {
  // Lazy-loaded so the pure/dry-run handler can be tested with injected
  // dependencies without requiring a Postgres environment at module load.
  return require('./pool');
}

function normalizeProtectRunIds(protectRunIds = []) {
  return Array.from(new Set(
    (Array.isArray(protectRunIds) ? protectRunIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  ));
}

/**
 * Predicate for snapshot rows that may be deleted for a window.
 * Keeps the newest `keep` succeeded runs, in-flight `running` rows, and
 * any explicitly protected ids. Never references `articles`.
 */
function expirableRunsPredicate({ windowHours, keep = DEFAULT_KEEP_RUNS, protectRunIds = [] } = {}) {
  if (!windowHours) throw new Error('expirableRunsPredicate: windowHours is required');
  const keepCount = parseBoundedInt(keep, DEFAULT_KEEP_RUNS, 1, 100);
  const protectedIds = normalizeProtectRunIds(protectRunIds);
  return {
    sql: `window_hours = $1
       AND status IS DISTINCT FROM 'running'
       AND NOT (run_id = ANY($2::bigint[]))
       AND run_id NOT IN (
         SELECT run_id
           FROM event_runs
          WHERE window_hours = $1
            AND status = 'succeeded'
          ORDER BY finished_at DESC NULLS LAST, run_id DESC
          LIMIT $3
       )`,
    params: [windowHours, protectedIds, keepCount],
    keep: keepCount,
    protectRunIds: protectedIds,
  };
}

async function getAggregationArticles({ cutoffAt, maxArticles = 10000, db } = {}) {
  const database = db || defaultPool();
  if (!cutoffAt) throw new Error('getAggregationArticles: cutoffAt is required');
  const { rows } = await database.query(
    `SELECT article_id, source_id, title, COALESCE(summary, '') AS summary,
            collected_at, published_at
       FROM articles
      WHERE collected_at >= $1
      ORDER BY collected_at DESC, article_id DESC
      LIMIT $2`,
    [cutoffAt, maxArticles]
  );
  return rows;
}

async function getLatestCollectedAt({ db } = {}) {
  const database = db || defaultPool();
  const { rows } = await database.query('SELECT MAX(collected_at) AS latest_collected_at FROM articles');
  return rows[0] && rows[0].latest_collected_at ? new Date(rows[0].latest_collected_at) : null;
}

async function countExpirableEventRuns({ windowHours, keep, protectRunIds, db } = {}) {
  const database = db || defaultPool();
  const predicate = expirableRunsPredicate({ windowHours, keep, protectRunIds });
  const { rows } = await database.query(
    `SELECT COUNT(*)::int AS count FROM event_runs WHERE ${predicate.sql}`,
    predicate.params
  );
  return rows[0] ? Number(rows[0].count) : 0;
}

/**
 * Delete at most `batchSize` expired event_runs for one window.
 * CASCADE removes news_events + news_event_articles. Call after persist COMMIT.
 */
async function expireOldEventRuns({
  windowHours,
  keep = DEFAULT_KEEP_RUNS,
  batchSize = DEFAULT_RETAIN_BATCH_SIZE,
  protectRunIds = [],
  dryRun = false,
  db,
} = {}) {
  const database = db || defaultPool();
  const predicate = expirableRunsPredicate({ windowHours, keep, protectRunIds });
  const limit = parseBoundedInt(batchSize, DEFAULT_RETAIN_BATCH_SIZE, 1, 100);
  const selectSql = `SELECT run_id
       FROM event_runs
      WHERE ${predicate.sql}
      ORDER BY finished_at ASC NULLS FIRST, run_id ASC
      LIMIT $4`;
  const selectParams = [...predicate.params, limit];
  const { rows } = await database.query(selectSql, selectParams);
  const runIds = rows.map((row) => Number(row.run_id));
  if (dryRun || runIds.length === 0) {
    return {
      dryRun: Boolean(dryRun),
      deleted: 0,
      candidateCount: runIds.length,
      runIds,
      keep: predicate.keep,
      windowHours,
    };
  }
  const deleted = await database.query(
    'DELETE FROM event_runs WHERE run_id = ANY($1::bigint[]) RETURNING run_id',
    [runIds]
  );
  return {
    dryRun: false,
    deleted: deleted.rowCount,
    candidateCount: runIds.length,
    runIds: deleted.rows.map((row) => Number(row.run_id)),
    keep: predicate.keep,
    windowHours,
  };
}

async function persistAggregationResult(result, { dryRun = false, config = {}, db } = {}) {
  if (dryRun) return { dryRun: true, eventCount: result.event_count, persisted: false };
  const database = db || defaultPool();
  const runKey = `${result.algorithm_version}:${result.window_hours}:${result.anchor_at}`;
  const client = await database.connect();
  let runId;
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `INSERT INTO event_runs
         (run_key, window_hours, algorithm_version, anchor_at, cutoff_at,
          status, article_count, candidate_count, event_count, config)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, 0, $8::jsonb)
       ON CONFLICT (run_key) DO UPDATE SET
         status = 'running', article_count = EXCLUDED.article_count,
         candidate_count = EXCLUDED.candidate_count, event_count = 0,
         error_message = NULL, started_at = NOW(), finished_at = NULL,
         config = EXCLUDED.config
       RETURNING run_id`,
      [runKey, result.window_hours, result.algorithm_version, result.anchor_at,
        result.cutoff_at, result.article_count, result.candidate_count, JSON.stringify(config)]
    );
    runId = run.rows[0].run_id;
    await client.query('DELETE FROM news_events WHERE run_id = $1', [runId]);
    for (const event of result.events) {
      const inserted = await client.query(
        `INSERT INTO news_events
           (run_id, representative_title, anchor_terms, article_count,
            media_count, coverage_score, first_seen_at, last_seen_at, algorithm_version)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
         RETURNING event_id`,
        [runId, event.representative_title, JSON.stringify(event.anchor_terms),
          event.article_count, event.media_count, event.coverage_score,
          event.first_seen_at, event.last_seen_at, event.algorithm_version]
      );
      const eventId = inserted.rows[0].event_id;
      for (const article of event.articles) {
        await client.query(
          `INSERT INTO news_event_articles
             (run_id, event_id, article_id, source_id, match_score, match_reason)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [runId, eventId, article.article_id, article.source_id,
            article.match_score, JSON.stringify(article.match_reason || {})]
        );
      }
    }
    await client.query(
      `UPDATE event_runs
          SET status = 'succeeded', event_count = $2, finished_at = NOW()
        WHERE run_id = $1`,
      [runId, result.event_count]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Expire old snapshots only after the new run is committed and the writer
  // client is released. Retain failures must not fail the job: a retry would
  // insert yet another snapshot.
  let retained;
  try {
    retained = await expireOldEventRuns({
      windowHours: result.window_hours,
      keep: config.keepRuns,
      batchSize: config.retainBatchSize,
      protectRunIds: [runId],
      db: database,
    });
  } catch (retainError) {
    return {
      dryRun: false,
      eventCount: result.event_count,
      persisted: true,
      runId,
      retained: false,
      retainError: retainError.message,
    };
  }
  return {
    dryRun: false,
    eventCount: result.event_count,
    persisted: true,
    runId,
    retained,
  };
}

module.exports = {
  getAggregationArticles,
  getLatestCollectedAt,
  persistAggregationResult,
  expireOldEventRuns,
  countExpirableEventRuns,
  expirableRunsPredicate,
};
