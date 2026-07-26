'use strict';

const { query } = require('./index');

/**
 * Persistence for the `sources` table (db/migrations/001_init.sql §19.1).
 *
 * Callers pass the snake_case `SourceProfile` shape produced by
 * `adapter.getSourceProfile()` (see src/core/types.js `SourceProfile` typedef and
 * src/adapters/detik/coreAdapter.js for the Detik mapping).
 */

/**
 * Upsert a source's profile. Safe to call on every discover/crawl-once run — it's
 * how the adapter's static config (display name, adapter version, crawl cadence, ...)
 * stays in sync with the `sources` row without a separate seed step.
 *
 * @param {{source_id: string, display_name: string, base_url: string, adapter_version: string, enabled?: boolean, timezone: string, crawl_interval_minutes: number, overlap_hours: number}} profile
 * @returns {Promise<{source_id: string}>}
 */
async function upsertSource(profile) {
  if (!profile || !profile.source_id) {
    throw new TypeError('upsertSource: profile.source_id is required');
  }

  const params = [
    profile.source_id,
    profile.display_name,
    profile.base_url,
    profile.adapter_version,
    profile.enabled !== false,
    profile.timezone,
    profile.crawl_interval_minutes,
    profile.overlap_hours,
  ];

  const { rows } = await query(
    `
    INSERT INTO sources (
      source_id, display_name, base_url, adapter_version, enabled,
      timezone, crawl_interval_minutes, overlap_hours
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (source_id) DO UPDATE SET
      display_name           = EXCLUDED.display_name,
      base_url                = EXCLUDED.base_url,
      adapter_version          = EXCLUDED.adapter_version,
      enabled                   = EXCLUDED.enabled,
      timezone                  = EXCLUDED.timezone,
      crawl_interval_minutes    = EXCLUDED.crawl_interval_minutes,
      overlap_hours              = EXCLUDED.overlap_hours
    RETURNING source_id
    `,
    params
  );

  return rows[0];
}

module.exports = {
  upsertSource,
};
