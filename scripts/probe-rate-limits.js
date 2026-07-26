#!/usr/bin/env node
'use strict';

/**
 * Sprint 12 (S12-B) — offline probe for per-source fetch delays.
 *
 * Prints crawl_interval_minutes + getFetchDelayMs() for every registered adapter
 * (and optional extra ids). No Redis/Postgres/live HTTP required.
 *
 * Usage:
 *   npm run smoke:rate-limits
 *   node scripts/probe-rate-limits.js
 *   node scripts/probe-rate-limits.js detik beritasatu unknown_id
 */

const { getSource, loadAllSources } = require('../src/sources/registry');
const {
  getFetchDelayMs,
  DEFAULT_FETCH_DELAY_MS,
  SOURCE_FETCH_DELAY_MS,
  RESTRICTED_SOURCE_IDS,
  MIN_DERIVED_DELAY_MS,
  MAX_DERIVED_DELAY_MS,
  RESTRICTED_MIN_FETCH_DELAY_MS,
  NOMINAL_FETCH_BATCH_SIZE,
  listUndelayConfiguredAdapterIds,
} = require('../src/queue/rateLimits');

const EXTRA_IDS = process.argv.slice(2);

function intervalMinutes(sourceId) {
  const entry = getSource(sourceId);
  if (!entry) return null;
  return entry.profile.crawl_interval_minutes ?? entry.profile.crawlIntervalMinutes ?? null;
}

function expectedDerivedMs(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const raw = Math.round((minutes * 60 * 1000) / NOMINAL_FETCH_BATCH_SIZE);
  return Math.min(Math.max(raw, MIN_DERIVED_DELAY_MS), MAX_DERIVED_DELAY_MS);
}

const rows = [];
for (const { sourceId } of loadAllSources()) {
  const minutes = intervalMinutes(sourceId);
  const delayMs = getFetchDelayMs(sourceId);
  const restricted = RESTRICTED_SOURCE_IDS.has(sourceId);
  let expected = expectedDerivedMs(minutes);
  if (expected != null && restricted) {
    expected = Math.max(expected, RESTRICTED_MIN_FETCH_DELAY_MS);
  }
  rows.push({
    sourceId,
    minutes,
    delayMs,
    restricted: restricted ? 'yes' : '',
    fallback: SOURCE_FETCH_DELAY_MS[sourceId],
    ok: expected == null ? delayMs === DEFAULT_FETCH_DELAY_MS : delayMs === expected,
  });
}

for (const sourceId of EXTRA_IDS) {
  if (rows.some((r) => r.sourceId === sourceId)) continue;
  rows.push({
    sourceId,
    minutes: intervalMinutes(sourceId),
    delayMs: getFetchDelayMs(sourceId),
    restricted: RESTRICTED_SOURCE_IDS.has(sourceId) ? 'yes' : '',
    fallback: SOURCE_FETCH_DELAY_MS[sourceId],
    ok: true,
  });
}

console.log(
  [
    'sourceId'.padEnd(18),
    'interval_m'.padStart(10),
    'delay_ms'.padStart(10),
    'restricted'.padStart(10),
    'fallback'.padStart(10),
    'match'.padStart(6),
  ].join(' ')
);
console.log('-'.repeat(68));

let failed = 0;
for (const r of rows) {
  const match = r.ok ? 'ok' : 'FAIL';
  if (!r.ok) failed += 1;
  console.log(
    [
      String(r.sourceId).padEnd(18),
      String(r.minutes ?? '—').padStart(10),
      String(r.delayMs).padStart(10),
      String(r.restricted).padStart(10),
      String(r.fallback ?? '—').padStart(10),
      match.padStart(6),
    ].join(' ')
  );
}

const missing = listUndelayConfiguredAdapterIds();
console.log('');
console.log(
  `formula: clamp((crawl_interval_minutes*60*1000)/${NOMINAL_FETCH_BATCH_SIZE}, ${MIN_DERIVED_DELAY_MS}, ${MAX_DERIVED_DELAY_MS})` +
    `; restricted floor=${RESTRICTED_MIN_FETCH_DELAY_MS}; unknown → ${DEFAULT_FETCH_DELAY_MS}`
);
if (missing.length) {
  console.error(`ERROR: adapters missing from PROFILE_DERIVED_SOURCE_IDS: ${missing.join(', ')}`);
  process.exitCode = 1;
} else if (failed) {
  console.error(`ERROR: ${failed} source(s) did not match expected derived delay`);
  process.exitCode = 1;
} else {
  console.log('all registered adapters have profile-derived delays configured');
}
