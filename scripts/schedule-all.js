#!/usr/bin/env node
/**
 * Cross-platform "register all adapters" scheduler entrypoint.
 *
 * Sets SCHEDULE_SOURCES to every id from `listAdapterIds()` (src/adapters/index.js),
 * then loads scheduler.js. Does NOT set CRAWL_LIVE (fixture-first default stays) and
 * does NOT force SCHEDULE_INTERVAL_OVERRIDE_MINUTES — leave unset for profile intervals
 * (docs/SCHEDULE_PROFILES.md), or set that env var yourself / in .env for a short soak.
 *
 * Unset SCHEDULE_SOURCES still means schedule nothing; this script is the explicit
 * opt-in for the full registry allow-list (Windows-safe; avoids bash-only VAR=value).
 *
 * Usage:
 *   npm run schedule:all
 *   # short local soak (profile intervals overridden uniformly):
 *   #   PowerShell:  $env:SCHEDULE_INTERVAL_OVERRIDE_MINUTES='2'; npm run schedule:all
 *   #   bash:        SCHEDULE_INTERVAL_OVERRIDE_MINUTES=2 npm run schedule:all
 *   # live: also set CRAWL_LIVE=true AND SCHEDULE_DISCOVER_LIMIT (or CRAWL_LIMIT)
 *
 * After register: keep the worker running (`npm start` / `npm run dev`).
 */
'use strict';

const { listAdapterIds } = require('../src/adapters');

const ids = listAdapterIds();
if (ids.length === 0) {
  console.error('[schedule:all] listAdapterIds() returned no adapters — refusing to register.');
  process.exit(1);
}

// Force allow-list before dotenv in scheduler.js (dotenv does not override existing keys).
process.env.SCHEDULE_SOURCES = ids.join(',');

console.log(
  `[schedule:all] SCHEDULE_SOURCES=${process.env.SCHEDULE_SOURCES} (${ids.length} adapters from listAdapterIds())`
);
if (process.env.SCHEDULE_INTERVAL_OVERRIDE_MINUTES) {
  console.log(
    `[schedule:all] SCHEDULE_INTERVAL_OVERRIDE_MINUTES=${process.env.SCHEDULE_INTERVAL_OVERRIDE_MINUTES} (preserved)`
  );
} else {
  console.log(
    '[schedule:all] using per-source profile intervals (set SCHEDULE_INTERVAL_OVERRIDE_MINUTES for a short soak)'
  );
}
if (process.env.CRAWL_LIVE === 'true') {
  console.log(
    '[schedule:all] CRAWL_LIVE=true — unbounded-live skip still applies; set SCHEDULE_DISCOVER_LIMIT or CRAWL_LIMIT'
  );
} else {
  console.log('[schedule:all] fixture-first (CRAWL_LIVE not forced true)');
}

require('./scheduler.js');
