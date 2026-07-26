'use strict';

const { query } = require('./index');

/**
 * Persistence for the `discovered_urls` table (db/migrations/001_init.sql §19.2) — an
 * append-style discovery log. Re-discovering the same (source_id, normalized_url,
 * discovery_channel) bumps `discovery_count`/`last_discovered_at` instead of inserting
 * a duplicate row (matches the table's UNIQUE constraint).
 */

/**
 * @param {{sourceId: string, rawUrl: string, normalizedUrl?: string, discoveryChannel: string, discoveryPage?: string, listingTitle?: string, publishedHint?: string}} item
 * @returns {Promise<{discovery_id: string}>}
 */
async function recordDiscoveredUrl(item) {
  const { sourceId, rawUrl, discoveryChannel } = item;
  if (!sourceId) throw new TypeError('recordDiscoveredUrl: sourceId is required');
  if (!rawUrl) throw new TypeError('recordDiscoveredUrl: rawUrl is required');
  if (!discoveryChannel) throw new TypeError('recordDiscoveredUrl: discoveryChannel is required');

  const params = [
    sourceId,
    rawUrl,
    item.normalizedUrl || rawUrl,
    discoveryChannel,
    item.discoveryPage || null,
    item.listingTitle || null,
    item.publishedHint || null,
  ];

  const { rows } = await query(
    `
    INSERT INTO discovered_urls (
      source_id, raw_url, normalized_url, discovery_channel, discovery_page,
      listing_title, published_hint, first_discovered_at, last_discovered_at, discovery_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), 1)
    ON CONFLICT (source_id, normalized_url, discovery_channel) DO UPDATE SET
      last_discovered_at = NOW(),
      discovery_count      = discovered_urls.discovery_count + 1,
      listing_title         = COALESCE(EXCLUDED.listing_title, discovered_urls.listing_title),
      published_hint        = COALESCE(EXCLUDED.published_hint, discovered_urls.published_hint)
    RETURNING discovery_id
    `,
    params
  );

  return rows[0];
}

/**
 * Lightweight "already seen in window" lookup (Sprint 13-C) — NOT playbook §20.4/§20.5
 * adaptive scheduling / watermark state. Returns the subset of `normalizedUrls` that
 * already appear in `discovered_urls` for this source with `last_discovered_at` within
 * the last `windowHours` hours (any discovery_channel).
 *
 * Call this *before* `recordDiscoveredUrl` — the upsert bumps `last_discovered_at` to
 * NOW(), which would make every URL look freshly seen if checked after write.
 *
 * Limits (intentional):
 * - Key is the discover-time string written to `discovered_urls.normalized_url`
 *   (hint or raw URL), which may differ from pipeline `normalizeUrl()`.
 * - Does not inspect `processing_status` / `articles`; a prior failed fetch is still
 *   treated as "seen" until the window elapses (BullMQ retries remain the recovery path).
 * - Empty `normalizedUrls` or non-positive `windowHours` → empty Set (no skip).
 *
 * @param {string} sourceId
 * @param {string[]} normalizedUrls
 * @param {number} windowHours - look-back window in hours (typically source `overlap_hours`)
 * @returns {Promise<Set<string>>}
 */
async function findRecentlySeenUrls(sourceId, normalizedUrls, windowHours) {
  if (!sourceId) throw new TypeError('findRecentlySeenUrls: sourceId is required');
  if (typeof windowHours !== 'number' || !Number.isFinite(windowHours) || windowHours <= 0) {
    return new Set();
  }

  const unique = [
    ...new Set(
      (normalizedUrls || []).filter((u) => typeof u === 'string' && u.length > 0)
    ),
  ];
  if (unique.length === 0) return new Set();

  const { rows } = await query(
    `
    SELECT DISTINCT normalized_url
    FROM discovered_urls
    WHERE source_id = $1
      AND normalized_url = ANY($2::text[])
      AND last_discovered_at > NOW() - ($3::numeric * INTERVAL '1 hour')
    `,
    [sourceId, unique, windowHours]
  );

  return new Set(rows.map((r) => r.normalized_url));
}

module.exports = {
  recordDiscoveredUrl,
  findRecentlySeenUrls,
};
