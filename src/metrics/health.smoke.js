#!/usr/bin/env node
'use strict';

/**
 * Offline smoke for report health thresholds (Sprint 14, S14-A).
 * No Postgres / Redis / live crawl required.
 *
 *   npm run smoke:report-check
 */

const {
  resolveHealthThresholds,
  evaluateReportHealth,
} = require('./health');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function emptyFunnelOk() {
  const result = evaluateReportHealth({
    funnel: [],
    sitemap: [],
    env: {},
  });
  assert(result.ok, 'empty funnel should be OK with defaults');
  assert(result.totals.total === 0, 'empty totals.total');
}

function idleWindowOk() {
  const result = evaluateReportHealth({
    funnel: [
      {
        source_id: 'detik',
        stored: 0,
        duplicate: 0,
        parse_fail: 0,
        blocked: 0,
        ignored_by_policy: 0,
        in_progress_or_other: 3,
        total: 3,
      },
    ],
    sitemap: [{ source_id: 'detik', total_urls: 3 }],
    env: {},
  });
  assert(result.ok, 'in-progress-only window should be OK (no terminal failures yet)');
}

function parseFailSpikeFails() {
  const result = evaluateReportHealth({
    funnel: [
      {
        source_id: 'detik',
        stored: 1,
        duplicate: 0,
        parse_fail: 9,
        blocked: 0,
        ignored_by_policy: 0,
        in_progress_or_other: 0,
        total: 10,
      },
    ],
    sitemap: [],
    env: {
      REPORT_PARSE_FAIL_MAX_RATIO: '0.5',
      REPORT_PARSE_FAIL_MIN_TOTAL: '5',
    },
  });
  assert(!result.ok, 'high parse_fail ratio should FAIL');
  assert(
    result.failures.some((f) => f.includes('parse_fail ratio')),
    `expected ratio failure, got: ${result.failures.join('; ')}`
  );
}

function allFailuresZeroStoredFails() {
  const result = evaluateReportHealth({
    funnel: [
      {
        source_id: 'suara',
        stored: 0,
        duplicate: 0,
        parse_fail: 2,
        blocked: 0,
        ignored_by_policy: 0,
        in_progress_or_other: 0,
        total: 2,
      },
    ],
    sitemap: [],
    env: {
      // Keep ratio check from also firing (terminal < min).
      REPORT_PARSE_FAIL_MIN_TOTAL: '10',
    },
  });
  assert(!result.ok, 'parse_fail with zero success should FAIL');
  assert(
    result.failures.some((f) => f.includes('stored+duplicate=0')),
    `expected zero-success failure, got: ${result.failures.join('; ')}`
  );
}

function healthyFixtureLikeOk() {
  const result = evaluateReportHealth({
    funnel: [
      {
        source_id: 'detik',
        stored: 1,
        duplicate: 1,
        parse_fail: 0,
        blocked: 0,
        ignored_by_policy: 0,
        in_progress_or_other: 0,
        total: 2,
      },
    ],
    sitemap: [{ source_id: 'detik', total_urls: 2 }],
    env: {},
  });
  assert(result.ok, 'fixture-like stored+duplicate should be OK');
}

function minDiscoveriesOptIn() {
  const off = evaluateReportHealth({
    funnel: [],
    sitemap: [{ source_id: 'detik', total_urls: 5 }],
    env: { REPORT_MIN_DISCOVERIES: '0' },
  });
  assert(off.ok, 'REPORT_MIN_DISCOVERIES=0 should not alarm on discoveries alone');

  const on = evaluateReportHealth({
    funnel: [],
    sitemap: [{ source_id: 'detik', total_urls: 5 }],
    env: { REPORT_MIN_DISCOVERIES: '1' },
  });
  assert(!on.ok, 'REPORT_MIN_DISCOVERIES=1 with discoveries and zero success should FAIL');
}

function requireStoredOptIn() {
  const result = evaluateReportHealth({
    funnel: [],
    sitemap: [],
    env: { REPORT_REQUIRE_STORED: '1' },
  });
  assert(!result.ok, 'REPORT_REQUIRE_STORED=1 on empty window should FAIL');
}

function maxCountOptIn() {
  const result = evaluateReportHealth({
    funnel: [
      {
        source_id: 'detik',
        stored: 10,
        duplicate: 0,
        parse_fail: 3,
        blocked: 0,
        ignored_by_policy: 0,
        in_progress_or_other: 0,
        total: 13,
      },
    ],
    sitemap: [],
    env: {
      REPORT_PARSE_FAIL_MAX_COUNT: '2',
      REPORT_PARSE_FAIL_MIN_TOTAL: '100', // disable ratio path
    },
  });
  assert(!result.ok, 'parse_fail above MAX_COUNT should FAIL');
}

function resolveDefaults() {
  const th = resolveHealthThresholds({});
  assert(th.parseFailMaxRatio === 0.5, 'default ratio');
  assert(th.parseFailMinTotal === 5, 'default min total');
  assert(th.parseFailMaxCount === null, 'default max count off');
  assert(th.requireStored === false, 'default requireStored off');
  assert(th.minDiscoveriesForStored === 0, 'default minDiscoveries off');
}

function main() {
  emptyFunnelOk();
  idleWindowOk();
  parseFailSpikeFails();
  allFailuresZeroStoredFails();
  healthyFixtureLikeOk();
  minDiscoveriesOptIn();
  requireStoredOptIn();
  maxCountOptIn();
  resolveDefaults();
  console.log('[health smoke] PASS');
}

try {
  main();
} catch (err) {
  console.error(`[health smoke] FAIL: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
