'use strict';

function defaultPool() {
  // Lazy-loaded so the pure/dry-run handler can be tested with injected
  // dependencies without requiring a Postgres environment at module load.
  return require('./pool');
}

async function getAggregationArticles({ cutoffAt, maxArticles = 10000, db } = {}) {
  const database = db || defaultPool();
  if (!cutoffAt) throw new Error('getAggregationArticles: cutoffAt is required');
  const { rows } = await database.query(
    `SELECT article_id, source_id, title, COALESCE(summary, '') AS summary,
            collected_at, published_at
       FROM articles
      WHERE collected_at >= $1
      ORDER BY collected_at ASC, article_id ASC
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

async function persistAggregationResult(result, { dryRun = false, config = {}, db } = {}) {
  if (dryRun) return { dryRun: true, eventCount: result.event_count, persisted: false };
  const database = db || defaultPool();
  const runKey = `${result.algorithm_version}:${result.window_hours}:${result.anchor_at}`;
  const client = await database.connect();
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
    const runId = run.rows[0].run_id;
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
    return { dryRun: false, eventCount: result.event_count, persisted: true, runId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getAggregationArticles, getLatestCollectedAt, persistAggregationResult };
