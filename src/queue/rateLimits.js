'use strict';

const { getSource } = require('../sources/registry');
const { listAdapterIds } = require('../adapters');

/**
 * Per-source rate limit lookup (playbook §13.3): per-media delays instead of one global
 * limit.
 *
 * Current enforcement (see src/workers/index.js `respectFetchDelay`) is a single-process,
 * in-memory "wait at least N ms since the last fetch for this source" delay applied right
 * before a crawl-fetch job runs. It is best-effort only:
 *   - it does not coordinate across multiple worker processes/machines;
 *   - it does not implement max_concurrent_requests or burst limits.
 *
 * TODO(F6): replace with a distributed limiter (Redis token bucket, or a BullMQ Pro group
 * rate limiter keyed by sourceId) once fetch workers are scaled beyond a single process.
 *
 * Sprint 12 (S12-B): every registered adapter's delay is derived from its
 * `SourceProfile.crawl_interval_minutes` (`src/sources/registry.js`), with last-resort
 * fallbacks in `SOURCE_FETCH_DELAY_MS`. Restricted-UA sources (`beritasatu`/`tribunnews`)
 * get a higher floor so the queue-level delay stays at least as polite as the clamp ceiling
 * (orthogonal to `RESTRICTED_LIVE_FETCH_DELAY_MS` in `fetchHtml.js` — do not lower this
 * path for those hosts; see `docs/RESTRICTED_UA_POLICY.md` §5).
 */
const DEFAULT_FETCH_DELAY_MS = 2000;

// All registered adapters derive their delay from profile (see deriveDelayFromProfile()).
// Kept as an explicit set (not "every listAdapterIds() call") so an accidental new adapter
// without a deliberate rate decision still falls through to DEFAULT_FETCH_DELAY_MS until
// it is added here + to SOURCE_FETCH_DELAY_MS.
const PROFILE_DERIVED_SOURCE_IDS = new Set([
  'detik',
  'viva',
  'suara',
  'cnn_indonesia',
  'liputan6',
  'tirto',
  'tempo',
  'kumparan',
  'jawa_pos',
  'okezone',
  'sindonews',
  'idn_times',
  'republika',
  'media_indonesia',
  'merdeka',
  'beritasatu',
  'tribunnews',
]);

// Restricted-UA sources (CloudFront / browser-class LIVE_UA). Queue-level delay uses a
// higher floor than the normal derived clamp — complementary to the small per-request pause
// in fetchHtml (`RESTRICTED_LIVE_FETCH_DELAY_MS`, default 800ms), not a replacement for it.
const RESTRICTED_SOURCE_IDS = new Set(['beritasatu', 'tribunnews']);

// Last-resort explicit values for PROFILE_DERIVED_SOURCE_IDS, only used if the registry
// lookup in deriveDelayFromProfile() fails/throws (e.g. called outside a fully wired-up
// process). Conceptually aligned with a ~15-minute crawl_interval_minutes → clamped
// derived delay (MAX_DERIVED_DELAY_MS). Restricted sources stay at the polite ceiling.
const SOURCE_FETCH_DELAY_MS = {
  detik: 5000,
  viva: 5000,
  suara: 5000,
  cnn_indonesia: 5000,
  liputan6: 5000,
  tirto: 5000,
  tempo: 5000,
  kumparan: 5000,
  jawa_pos: 5000,
  okezone: 5000,
  sindonews: 5000,
  idn_times: 5000,
  republika: 5000,
  media_indonesia: 5000,
  merdeka: 5000,
  beritasatu: 5000,
  tribunnews: 5000,
};

// A profile-derived delay is clamped to this range so a very short or very long
// crawl_interval_minutes can't produce a useless (near-zero or multi-minute) fetch delay.
const MIN_DERIVED_DELAY_MS = 500;
const MAX_DERIVED_DELAY_MS = 5000;

// Restricted sources never go below the clamp ceiling, even if a short interval would
// otherwise derive a lower value after clamp (e.g. future S12-A interval tweaks).
const RESTRICTED_MIN_FETCH_DELAY_MS = MAX_DERIVED_DELAY_MS;

// Nominal number of crawl-fetch jobs one discover run is expected to enqueue for a source
// (~DEFAULT_DISCOVER_LIMIT across adapters); the derived delay spreads
// crawl_interval_minutes evenly across a batch of this size so a whole batch of fetches
// comfortably fits inside one crawl interval instead of firing back-to-back.
const NOMINAL_FETCH_BATCH_SIZE = 8;

/**
 * @param {string} sourceId
 * @returns {number|undefined} a conservative per-fetch delay derived from
 *   `crawl_interval_minutes`, or `undefined` if the source/profile can't be resolved.
 */
function deriveDelayFromProfile(sourceId) {
  try {
    const entry = getSource(sourceId);
    const minutes = entry && (entry.profile.crawl_interval_minutes ?? entry.profile.crawlIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return undefined;
    }
    const derivedMs = Math.round((minutes * 60 * 1000) / NOMINAL_FETCH_BATCH_SIZE);
    let ms = Math.min(Math.max(derivedMs, MIN_DERIVED_DELAY_MS), MAX_DERIVED_DELAY_MS);
    if (RESTRICTED_SOURCE_IDS.has(sourceId)) {
      ms = Math.max(ms, RESTRICTED_MIN_FETCH_DELAY_MS);
    }
    return ms;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {string} sourceId
 * @returns {number} minimum ms between two crawl-fetch jobs for this source.
 */
function getFetchDelayMs(sourceId) {
  if (PROFILE_DERIVED_SOURCE_IDS.has(sourceId)) {
    const derived = deriveDelayFromProfile(sourceId);
    if (derived !== undefined) {
      return derived;
    }
    if (Object.prototype.hasOwnProperty.call(SOURCE_FETCH_DELAY_MS, sourceId)) {
      return SOURCE_FETCH_DELAY_MS[sourceId];
    }
  }
  return DEFAULT_FETCH_DELAY_MS;
}

/**
 * Sanity helper for probes: every registered adapter id should be in
 * PROFILE_DERIVED_SOURCE_IDS (Sprint 12). Returns ids that are registered but missing
 * from the derived set (empty when in sync).
 * @returns {string[]}
 */
function listUndelayConfiguredAdapterIds() {
  return listAdapterIds().filter((id) => !PROFILE_DERIVED_SOURCE_IDS.has(id));
}

module.exports = {
  DEFAULT_FETCH_DELAY_MS,
  SOURCE_FETCH_DELAY_MS,
  PROFILE_DERIVED_SOURCE_IDS,
  RESTRICTED_SOURCE_IDS,
  MIN_DERIVED_DELAY_MS,
  MAX_DERIVED_DELAY_MS,
  RESTRICTED_MIN_FETCH_DELAY_MS,
  NOMINAL_FETCH_BATCH_SIZE,
  getFetchDelayMs,
  listUndelayConfiguredAdapterIds,
};
