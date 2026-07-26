'use strict';

const { parseListingDate } = require('./parseListingDate');

/**
 * Overlap-window helpers (playbook `Reliable-News-Article-Scraping.md` §20.2).
 *
 * Every scheduled discovery run re-scans a source's listing(s) back past its own
 * `overlap_hours` (see each adapter's `SourceProfile.overlapHours` / the `sources` table's
 * `overlap_hours` column) instead of trusting a watermark alone -- so a missed/late/failed
 * run, or a listing re-ordering, doesn't silently lose articles. §20.2 example:
 *
 *   crawl_interval_minutes: 10
 *   overlap_hours: 72
 *
 *   -> crawl runs every 10 minutes; the listing is scanned until an item older than 72
 *      hours is seen; re-finding already-known URLs is expected and handled by
 *      dedup (src/db/discoveredUrls.js / the `discovered_urls`+`processing_status` unique
 *      constraints), not by this module.
 *
 * This module only computes/applies the cutoff. It does not paginate, fetch, or know
 * anything about a specific source's listing markup -- that stays adapter-owned (see
 * `src/adapters/detik/index.js` / `src/adapters/suara/index.js` for the two staging
 * adapters wired up to it in Sprint 8).
 *
 * Listing hints are parsed via `parseListingDate` (Indonesian day/month forms + ISO), so
 * overlap stop can activate on fixture/live hints that plain `new Date(...)` rejects.
 */

/**
 * @param {number} overlapHours - non-negative number of hours to look back from `now`.
 * @param {Date} [now] - injectable clock, mainly for deterministic tests.
 * @returns {Date} the cutoff instant: items published before this are outside the overlap
 *   window and no longer need (re-)discovering this run.
 */
function getOverlapCutoffAt(overlapHours, now = new Date()) {
  if (typeof overlapHours !== 'number' || !Number.isFinite(overlapHours) || overlapHours < 0) {
    throw new TypeError(`getOverlapCutoffAt: overlapHours must be a non-negative number, got ${overlapHours}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('getOverlapCutoffAt: now must be a valid Date');
  }
  return new Date(now.getTime() - overlapHours * 60 * 60 * 1000);
}

/**
 * Convenience ISO-string wrapper around `getOverlapCutoffAt`, since job payloads/ctx objects
 * passed across the queue boundary need a serializable value rather than a `Date` instance.
 *
 * @param {number} overlapHours
 * @param {Date} [now]
 * @returns {string} ISO 8601 UTC cutoff timestamp.
 */
function getOverlapCutoffIso(overlapHours, now) {
  return getOverlapCutoffAt(overlapHours, now).toISOString();
}

/**
 * @param {string|Date|null|undefined} publishedHint - best-effort listing timestamp (e.g.
 *   `DiscoveryItem.published_hint` / a raw adapter's `publishedHint`). May be ISO or a
 *   human-readable Indonesian listing string — parsed by `parseListingDate`.
 * @param {Date} cutoffAt - as returned by `getOverlapCutoffAt()`.
 * @returns {boolean} `true` only when `publishedHint` both parses AND is strictly older than
 *   `cutoffAt`. Returns `false` ("not old enough to stop for") when the hint is missing or
 *   unparseable, so callers safely fall back to a plain item-count limit instead of
 *   mistakenly stopping discovery early on bad data.
 */
function isOlderThanCutoff(publishedHint, cutoffAt) {
  if (!publishedHint) return false;
  if (!(cutoffAt instanceof Date) || Number.isNaN(cutoffAt.getTime())) return false;
  const parsed = parseListingDate(publishedHint);
  if (!parsed) return false;
  return parsed.getTime() < cutoffAt.getTime();
}

/**
 * Shared "stop scanning a listing once we're past the overlap window" helper for adapter
 * `discover()` implementations. Adapters supply their own listing `items` in newest-first
 * document order (true of every onboarded listing page today) plus a `getPublishedHint`
 * accessor; this walks the (optionally limit-capped) list and keeps everything up to -- but
 * not including -- the first item whose hint is confidently older than `cutoffAt`.
 *
 * RESIDUAL LIMITATION (playbook §20.2 "stop when older than cutoff"): this can only stop
 * early when the adapter's listing actually exposes a per-item timestamp that
 * `parseListingDate` can resolve (ISO or Indonesian listing forms). Time-only fragments
 * (e.g. `"07:08"`) and listings that never scrape a hint (e.g. detik live indeks today)
 * still degrade to a plain `limit` slice. Each call site documents its own residual.
 *
 * @param {Array<Object>} items - listing items, newest-first.
 * @param {{cutoffAt?: Date, limit?: number, getPublishedHint: (item: Object) => (string|Date|undefined)}} opts
 * @returns {Array<Object>} the kept prefix of `items`.
 */
function takeUntilOverlapCutoff(items, { cutoffAt, limit, getPublishedHint } = {}) {
  const source = Array.isArray(items) ? items : [];
  const capped = typeof limit === 'number' && limit > 0 ? source.slice(0, limit) : source.slice();

  if (!cutoffAt || !(cutoffAt instanceof Date) || Number.isNaN(cutoffAt.getTime())) {
    return capped;
  }

  const kept = [];
  for (const item of capped) {
    const hint = typeof getPublishedHint === 'function' ? getPublishedHint(item) : undefined;
    if (isOlderThanCutoff(hint, cutoffAt)) {
      break;
    }
    kept.push(item);
  }
  return kept;
}

module.exports = {
  getOverlapCutoffAt,
  getOverlapCutoffIso,
  isOlderThanCutoff,
  takeUntilOverlapCutoff,
};
