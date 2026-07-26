'use strict';

const { getAdapter } = require('../../adapters');
const { enqueueFetch } = require('../../queue/enqueue');
const { upsertSource } = require('../../db/sources');
const { recordDiscoveredUrl, findRecentlySeenUrls } = require('../../db/discoveredUrls');
const { upsertProcessingStatus } = require('../../db/articles');
const { PROCESSING_STATUS } = require('../../core/status');
const { isLiveCrawlEnabled } = require('../lib/fetchHtml');
const { resolveDiscoverLimit } = require('../../core/crawlLimit');
const { getOverlapCutoffAt } = require('../../core/overlap');

/**
 * crawl-discover handler (see src/workers/index.js for the BullMQ Worker wiring):
 *   getAdapter(sourceId) -> upsert `sources` row -> adapter.discover() -> for each
 *   item: record `discovered_urls`, mark `processing_status = discovered`,
 *   enqueueFetch() — unless the URL was already seen in the overlap window (S13-C).
 *
 * Limit (Sprint 0 live-crawl safety, see README.md "CRAWL_LIVE" / src/core/crawlLimit.js):
 * an explicit `job.data.limit` (set via `enqueueDiscover(sourceId, { limit })`) takes
 * priority, falling back to the `CRAWL_LIMIT` env var. Required (throws) when
 * `CRAWL_LIVE=true` and neither is set, so a live discovery job can never enqueue an
 * unbounded number of fetches.
 *
 * Overlap window (Sprint 8, playbook §20.2, see src/core/overlap.js): every run also gets
 * `ctx.overlapHours` (the source's own `SourceProfile.overlap_hours`) and `ctx.overlapCutoffAt`
 * (ISO 8601, `now - overlapHours`) so an adapter's `discover()` can stop paginating/listing
 * once it reaches items older than the cutoff, instead of relying on `ctx.limit` alone. This
 * is computed here (not read from `src/sources/scheduleConfig.js`, which is scheduler-only
 * config gated behind `SCHEDULE_SOURCES`) so it applies uniformly whether a discover job was
 * enqueued by the scheduler or manually/one-off.
 *
 * Skip-enqueue of recently seen URLs (Sprint 13-C, lightweight only):
 * before writing rediscovery rows, the handler batch-queries `discovered_urls` for items
 * whose `last_discovered_at` falls inside `overlap_hours`. Those URLs are still logged via
 * `recordDiscoveredUrl` (rediscovery expected) but do **not** get a new fetch job and do
 * **not** clobber an existing `processing_status`. This is skip-enqueue only — not adaptive
 * scheduling / full watermark (§20.4/§20.5 remain out of scope). Pagination-stop on
 * consecutive duplicate pages is deferred (would require per-adapter changes).
 *
 * @param {import('bullmq').Job} job - job.data: { sourceId, enqueuedAt, limit? }
 * @param {{log?: Function}} [opts]
 * @returns {Promise<{ok: boolean, sourceId: string, discovered: number, enqueued: number, skippedSeen: number, limit?: number}>}
 */
async function handleDiscover(job, opts = {}) {
  const log = opts.log || (() => {});
  const { sourceId, limit: jobLimit } = job.data;

  // See scripts/crawl-once.js for why fixtureOnly/liveDiscover are derived from
  // CRAWL_LIVE here rather than left for each adapter to gate on its own.
  const liveCrawl = isLiveCrawlEnabled();
  const limit = resolveDiscoverLimit({ explicitLimit: jobLimit, liveCrawl });

  const adapter = getAdapter(sourceId);
  const profile = adapter.getSourceProfile();

  await upsertSource(profile);

  const overlapHours = profile.overlap_hours ?? profile.overlapHours;
  const overlapCutoffAt =
    typeof overlapHours === 'number' && Number.isFinite(overlapHours)
      ? getOverlapCutoffAt(overlapHours).toISOString()
      : undefined;

  const discovered = await adapter.discover({
    sourceId,
    sourceProfile: profile,
    fixtureOnly: !liveCrawl,
    liveDiscover: liveCrawl,
    limit,
    overlapHours,
    overlapCutoffAt,
  });

  // Defense-in-depth: cap here too even if the adapter's own discover() didn't fully
  // honor ctx.limit internally (see scripts/crawl-once.js for the same rationale).
  const items = typeof limit === 'number' ? discovered.slice(0, limit) : discovered;

  const normalizedKeys = items
    .filter((item) => item && item.url)
    .map((item) => (item.metadata && item.metadata.normalizedUrlHint) || item.url);

  let recentlySeen = new Set();
  if (
    typeof overlapHours === 'number' &&
    Number.isFinite(overlapHours) &&
    overlapHours > 0 &&
    normalizedKeys.length > 0
  ) {
    try {
      recentlySeen = await findRecentlySeenUrls(sourceId, normalizedKeys, overlapHours);
    } catch (err) {
      // Fail open: if the lookup fails, behave like pre-S13-C (enqueue everything).
      log('discover_seen_lookup_failed', { sourceId, error: err.message });
      recentlySeen = new Set();
    }
  }

  let enqueued = 0;
  let skippedSeen = 0;
  /** @type {Set<string>} in-run dedupe so dual-channel listings don't double-enqueue */
  const enqueuedThisRun = new Set();

  for (const item of items) {
    if (!item || !item.url) continue;

    const normalizedUrl = (item.metadata && item.metadata.normalizedUrlHint) || item.url;
    const skipFetch =
      recentlySeen.has(normalizedUrl) || enqueuedThisRun.has(normalizedUrl);

    try {
      await recordDiscoveredUrl({
        sourceId,
        rawUrl: item.url,
        normalizedUrl,
        discoveryChannel: item.channel,
        listingTitle: item.title_hint,
        publishedHint: item.published_hint,
      });

      // Only stamp `discovered` when we are about to enqueue — otherwise rediscovery
      // would clobber a terminal stored/duplicate status for no new fetch work.
      if (!skipFetch) {
        await upsertProcessingStatus({
          sourceId,
          normalizedUrl: item.url,
          status: PROCESSING_STATUS.DISCOVERED,
          reason: `discovery_channel_${item.channel || 'unknown'}`,
        });
      }
    } catch (err) {
      log('discover_record_failed', { sourceId, url: item.url, error: err.message });
    }

    if (skipFetch) {
      skippedSeen += 1;
      log('discover_skip_seen', { sourceId, url: item.url, normalizedUrl });
      continue;
    }

    await enqueueFetch({
      sourceId,
      url: item.url,
      discoveryChannel: item.channel,
      listingTitle: item.title_hint,
      publishedHint: item.published_hint,
    });
    enqueuedThisRun.add(normalizedUrl);
    enqueued += 1;
  }

  return {
    ok: true,
    sourceId,
    discovered: items.length,
    enqueued,
    skippedSeen,
    limit,
  };
}

module.exports = { handleDiscover };
