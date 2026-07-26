#!/usr/bin/env node
'use strict';

/**
 * Sprint 13 smoke: Indonesian listing-date parse + overlap mid-list stop.
 *
 * Usage: node src/core/parseListingDate.smoke.js
 *    or: npm run smoke:overlap-parse
 */

const { parseListingDate, parseListingDateIso } = require('./parseListingDate');
const { isOlderThanCutoff, takeUntilOverlapCutoff } = require('./overlap');
const rawDetik = require('../adapters/detik');
const rawSuara = require('../adapters/suara');
const detikCore = require('../adapters/detik/coreAdapter');
const suaraCore = require('../adapters/suara/coreAdapter');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIso(actual, expectedIso, label) {
  assert(actual === expectedIso, `${label}: expected ${expectedIso}, got ${actual}`);
}

async function main() {
  // --- parseListingDate: Indonesian strings → valid Date (WIB = +07:00) ---
  assertIso(
    parseListingDateIso('Kamis, 23 Jul 2026 14:35 WIB'),
    '2026-07-23T07:35:00.000Z',
    'detik-style Jul abbr'
  );
  assertIso(
    parseListingDateIso("Jum'at, 24 Juli 2026 | 07:08 WIB"),
    '2026-07-24T00:08:00.000Z',
    'suara-style full month + pipe'
  );
  assertIso(
    parseListingDateIso("Jum'at, 24 Juli 2026 - 14:00 WIB"),
    '2026-07-24T07:00:00.000Z',
    'sindonews-style dash separator'
  );
  assertIso(
    parseListingDateIso('24 Jul 2026, 16:36 WIB'),
    '2026-07-24T09:36:00.000Z',
    'idn_times-style comma'
  );
  assertIso(
    parseListingDateIso('24 Juli 2026 | 11.32 WIB'),
    '2026-07-24T04:32:00.000Z',
    'tempo-style period time'
  );
  assert(
    parseListingDate('07:08') === undefined,
    'time-only fragment must stay unparseable (no invented day)'
  );
  assert(
    parseListingDateIso('2026-07-24T07:08:59+07:00') === '2026-07-24T00:08:59.000Z',
    'ISO with offset still works'
  );

  // --- takeUntilOverlapCutoff stops mid-list when hints parse ---
  const items = [
    { id: 'a', publishedHint: 'Kamis, 23 Jul 2026 15:10 WIB' }, // 08:10Z
    { id: 'b', publishedHint: 'Kamis, 23 Jul 2026 14:35 WIB' }, // 07:35Z
    { id: 'c', publishedHint: 'Kamis, 23 Jul 2026 13:00 WIB' }, // 06:00Z
  ];
  const cutoffAt = new Date('2026-07-23T08:00:00.000Z'); // between a and b
  assert(isOlderThanCutoff(items[0].publishedHint, cutoffAt) === false, 'newest must be inside window');
  assert(isOlderThanCutoff(items[1].publishedHint, cutoffAt) === true, 'mid item must be older than cutoff');

  const kept = takeUntilOverlapCutoff(items, {
    cutoffAt,
    limit: 10,
    getPublishedHint: (item) => item.publishedHint,
  });
  assert(kept.length === 1 && kept[0].id === 'a', `expected mid-list stop keeping only 'a', got ${JSON.stringify(kept.map((x) => x.id))}`);

  // Unparseable hints must NOT stop (safe fallback to limit-slice of capped list).
  const unparseable = takeUntilOverlapCutoff(
    [
      { id: 'x', publishedHint: '07:08' },
      { id: 'y', publishedHint: '06:00' },
    ],
    { cutoffAt, limit: 10, getPublishedHint: (item) => item.publishedHint }
  );
  assert(unparseable.length === 2, 'unparseable hints must not trigger early stop');

  // --- Adapter fixture discover: cutoff between the two fixture hints ---
  const detikCutoff = '2026-07-23T08:00:00.000Z'; // between 15:10 and 14:35 WIB
  const { items: detikItems } = await rawDetik.discover({
    fixtureOnly: true,
    overlapCutoffAt: detikCutoff,
    limit: 8,
  });
  assert(
    detikItems.length === 1,
    `detik fixture overlap stop: expected 1 item, got ${detikItems.length}`
  );
  assert(
    /d-1234568/.test(detikItems[0].rawUrl),
    `detik should keep newest fixture URL, got ${detikItems[0].rawUrl}`
  );

  const suaraCutoff = '2026-07-24T00:00:00.000Z'; // between 07:08 and 06:00 WIB
  const { items: suaraItems } = await rawSuara.discover({
    overlapCutoffAt: suaraCutoff,
    limit: 8,
  });
  assert(
    suaraItems.length === 1,
    `suara fixture overlap stop: expected 1 item, got ${suaraItems.length}`
  );

  // coreAdapter tryParseHint must populate published_hint for Indonesian fixture strings
  const detikCoreItem = detikCore.toCoreDiscoveryItem(detikItems[0]);
  assert(
    typeof detikCoreItem.published_hint === 'string' && !Number.isNaN(new Date(detikCoreItem.published_hint).getTime()),
    'detik core published_hint must be a parseable ISO string'
  );
  const suaraCoreItem = suaraCore.toCoreDiscoveryItem(suaraItems[0]);
  assert(
    typeof suaraCoreItem.published_hint === 'string' && !Number.isNaN(new Date(suaraCoreItem.published_hint).getTime()),
    'suara core published_hint must be a parseable ISO string'
  );

  console.log('[overlap-parse smoke] OK');
}

main().catch((err) => {
  console.error('[overlap-parse smoke] FAIL:', err.message);
  process.exitCode = 1;
});
