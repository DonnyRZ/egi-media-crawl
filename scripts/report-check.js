#!/usr/bin/env node
'use strict';

// Ops health wrapper around the Sprint 9 crawl report (Sprint 14, S14-A).
// Prints the same markdown report as `npm run report`, then evaluates simple thresholds
// and exits non-zero when they fire. Needs only DATABASE_URL (no Redis).
//
// Usage (once):
//   npm run report:check
//   npm run report:check -- --since=24h
//   npm run report:check -- --since=24h --source=detik
//
// Periodic (VPS-ready pattern — no deploy here; S14-B owns docs/VPS_READY.md):
//   # cron (every hour, example)
//   0 * * * * cd /path/to/egi-media-crawl && npm run report:check >> /var/log/egi-crawl-report.log 2>&1
//   # Windows Task Scheduler — Action: start a program
//   #   Program: npm  (or full path to npm.cmd)
//   #   Arguments: run report:check
//   #   Start in: D:\Project\EGI Media\egi-media-crawl
//
// Thresholds (env; safe defaults do not alarm on an empty fresh DB):
//   REPORT_SINCE / --since          window (default 24h)
//   REPORT_PARSE_FAIL_MAX_RATIO     default 0.5
//   REPORT_PARSE_FAIL_MIN_TOTAL     default 5 (ratio ignored below this terminal count)
//   REPORT_PARSE_FAIL_MAX_COUNT     optional absolute cap (unset = off)
//   REPORT_REQUIRE_STORED           default 0; set 1 to require stored+duplicate > 0
//   REPORT_MIN_DISCOVERIES          default 0; when >0 and discoveries >= N with
//                                   stored+duplicate=0 → fail

require('dotenv').config();

const { pool } = require('../src/db');
const {
  resolveSince,
  getFunnelCounts,
  getFieldFillStats,
  getOnlyInSitemapStats,
  formatReport,
} = require('../src/metrics/report');
const { evaluateReportHealth, formatHealthSummary } = require('../src/metrics/health');

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
      'DATABASE_URL is not set. Copy .env.example to .env, set DATABASE_URL, then re-run `npm run report:check`.'
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

  const health = evaluateReportHealth({ funnel, sitemap });
  console.error(formatHealthSummary(health));

  if (!health.ok) {
    process.exitCode = 2;
  }
}

run()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`[report-check] failed: ${describeError(err)}`);
    process.exitCode = 1;
    await pool.end().catch(() => {});
  });
