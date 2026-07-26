#!/usr/bin/env node
'use strict';

// One command, one crawl report (Sprint 9, S9-A). Prints funnel counts (stored/duplicate/
// parse_fail), optional-field fill %, and an optional only_in_sitemap section to stdout.
// Needs only DATABASE_URL (no Redis) — see README.md "Reporting" for the full writeup.
// For periodic health (exit non-zero on thresholds), use `npm run report:check` instead
// (`scripts/report-check.js`, Sprint 14).
//
// Usage:
//   npm run report
//   npm run report -- --since=24h
//   npm run report -- --since=24h --source=detik
//
// --since accepts <number><m|h|d|w> (e.g. 30m, 24h, 7d, 2w). Defaults to the REPORT_SINCE
// env var if set, else "24h". --source filters every section to a single source_id.

require('dotenv').config();

const { pool } = require('../src/db');
const { resolveSince, getFunnelCounts, getFieldFillStats, getOnlyInSitemapStats, formatReport } = require(
  '../src/metrics/report'
);

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

function maskConnectionString(value) {
  return value.replace(/:\/\/([^:]+):([^@]*)@/, '://$1:****@');
}

/**
 * `pg`/Node's `net` module surface connection failures (e.g. Postgres not running) as an
 * `AggregateError` with an empty top-level `.message` and the real reason(s) nested under
 * `.errors`. Unwrap that so the CLI's error output is actually actionable (same helper as
 * `scripts/crawl-once.js`).
 * @param {Error} err
 * @returns {string}
 */
function describeError(err) {
  if (err && err.message) return err.message;
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map((e) => e.message || String(e)).join('; ');
  }
  return String(err);
}

async function assertDatabaseReady() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, set DATABASE_URL, then re-run `npm run report`.'
    );
  }

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(
      `Could not connect to Postgres at ${maskConnectionString(process.env.DATABASE_URL)}. ` +
        `Make sure the database is running and migrated (npm run migrate). Original error: ${describeError(err)}`
    );
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const sourceFilter = args.source || undefined;
  const { raw: since, sinceDate } = resolveSince({
    cliSince: args.since,
    envSince: process.env.REPORT_SINCE,
  });

  await assertDatabaseReady();

  const [funnel, fieldFill, sitemap] = await Promise.all([
    getFunnelCounts(pool, { sinceDate, sourceId: sourceFilter }),
    getFieldFillStats(pool, { sinceDate, sourceId: sourceFilter }),
    getOnlyInSitemapStats(pool, { sinceDate, sourceId: sourceFilter }),
  ]);

  const report = formatReport({
    since,
    sinceDate,
    generatedAt: new Date(),
    sourceFilter,
    funnel,
    fieldFill,
    sitemap,
  });

  console.log(report);
}

run()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`[crawl-report] failed: ${describeError(err)}`);
    process.exitCode = 1;
    await pool.end().catch(() => {});
  });
