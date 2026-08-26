#!/usr/bin/env node
'use strict';

/**
 * Batched reclaim of unbounded event_runs snapshots.
 *
 * Default is dry-run. Deletes only event_runs (CASCADE to news_events /
 * news_event_articles). Aborts if `articles` row count drops.
 *
 *   node scripts/event-aggregation-retain.js
 *   node scripts/event-aggregation-retain.js --execute --keep=3 --batch=25
 */

require('dotenv').config();
const {
  DEFAULT_KEEP_RUNS,
  DEFAULT_WINDOWS,
  getEventAggregationConfig,
  parseBoundedInt,
} = require('../src/event-aggregation/config');
const { countExpirableEventRuns, expireOldEventRuns } = require('../src/db/newsEvents');
const pool = require('../src/db/pool');

function parseArgs(argv) {
  const parsed = {
    execute: false,
    keep: undefined,
    batch: 25,
    sleepMs: 500,
    windows: null,
  };
  for (const arg of argv) {
    if (arg === '--execute') parsed.execute = true;
    else if (arg === '--dry-run') parsed.execute = false;
    else if (arg.startsWith('--keep=')) parsed.keep = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--batch=')) parsed.batch = Number.parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--sleep-ms=')) parsed.sleepMs = Number.parseInt(arg.slice(11), 10);
    else if (arg.startsWith('--window=')) parsed.windows = [Number.parseInt(arg.slice(9), 10)];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function articleCount(db) {
  const { rows } = await db.query('SELECT COUNT(*)::bigint AS count FROM articles');
  return Number(rows[0].count);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getEventAggregationConfig();
  const keep = parseBoundedInt(args.keep, config.keepRuns || DEFAULT_KEEP_RUNS, 1, 100);
  const batch = parseBoundedInt(args.batch, 25, 1, 100);
  const windows = args.windows && args.windows.every((item) => Number.isInteger(item) && item > 0)
    ? args.windows
    : (config.windows.length ? config.windows : DEFAULT_WINDOWS.slice());
  const articlesBefore = await articleCount(pool);
  const summary = {
    ok: true,
    dryRun: !args.execute,
    keep,
    batch,
    articlesBefore,
    windows: [],
  };

  for (const windowHours of windows) {
    const expirable = await countExpirableEventRuns({ windowHours, keep, db: pool });
    const windowSummary = { windowHours, expirable, deleted: 0, batches: 0 };
    if (!args.execute) {
      summary.windows.push(windowSummary);
      continue;
    }
    let remaining = expirable;
    while (remaining > 0) {
      const result = await expireOldEventRuns({
        windowHours,
        keep,
        batchSize: batch,
        db: pool,
      });
      windowSummary.batches += 1;
      windowSummary.deleted += result.deleted;
      const articlesNow = await articleCount(pool);
      if (articlesNow < articlesBefore) {
        throw new Error(`articles count dropped from ${articlesBefore} to ${articlesNow}; aborting retain`);
      }
      if (result.deleted === 0) break;
      remaining = await countExpirableEventRuns({ windowHours, keep, db: pool });
      if (remaining > 0 && args.sleepMs > 0) await sleep(args.sleepMs);
    }
    windowSummary.remaining = remaining;
    summary.windows.push(windowSummary);
  }

  summary.articlesAfter = await articleCount(pool);
  summary.articlesUnchanged = summary.articlesAfter >= articlesBefore;
  console.log(JSON.stringify(summary));
}

main()
  .catch((error) => {
    console.error('[event-aggregation-retain] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
