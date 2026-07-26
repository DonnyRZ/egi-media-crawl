'use strict';

/**
 * Query + formatting helpers for the crawl report (Sprint 9, S9-A).
 *
 * One command, one report: `npm run report` (see `scripts/crawl-report.js`). This module
 * only knows how to ask Postgres questions and turn the answers into text — the CLI wrapper
 * owns argv parsing, DATABASE_URL/connection lifecycle, and exit codes.
 *
 * Window conventions (documented once here, not repeated at every call site):
 *   - Funnel counts (`getFunnelCounts`) window on `processing_status.status_updated_at` —
 *     i.e. "state transitions that happened in the window", not "URLs first seen in the
 *     window". This makes stored/duplicate/parse_fail counts reflect what the pipeline
 *     actually *did* during the window, including re-crawls of older URLs.
 *   - Field fill % (`getFieldFillStats`) windows on `articles.last_seen_at` — bumped on
 *     every store pass (insert *and* update), so it reflects "articles touched by a crawl
 *     in the window", matching the funnel window's spirit more closely than `collected_at`
 *     alone would for a re-crawled article whose `collected_at` may lag if store code
 *     changes in the future.
 *   - only_in_sitemap (`getOnlyInSitemapStats`) windows on `discovered_urls.last_discovered_at`
 *     — bumped on every re-discovery, same rationale as the two above.
 */

const { N5_OPTIONAL_FIELDS } = require('../core/fieldContract');

// Soft-required `published_at` (see fieldContract.js) plus every fully-optional N5 field.
// Single source of truth for which columns the fill-rate section reports on.
const REPORT_OPTIONAL_FIELDS = ['published_at', ...N5_OPTIONAL_FIELDS];

// How to test "is this column filled" per column type. Anything not listed defaults to the
// plain text rule (`IS NOT NULL AND <> ''`).
const FIELD_KIND = Object.freeze({
  published_at: 'timestamp',
  updated_at_source: 'timestamp',
  tags: 'json_array',
  field_provenance: 'json_object',
});

function fillExpr(field) {
  const kind = FIELD_KIND[field] || 'text';
  if (kind === 'timestamp') return `${field} IS NOT NULL`;
  if (kind === 'json_array') {
    return `(${field} IS NOT NULL AND jsonb_typeof(${field}) = 'array' AND jsonb_array_length(${field}) > 0)`;
  }
  if (kind === 'json_object') {
    return `(${field} IS NOT NULL AND jsonb_typeof(${field}) = 'object' AND ${field} <> '{}'::jsonb)`;
  }
  return `(${field} IS NOT NULL AND ${field} <> '')`;
}

const SINCE_UNIT_MS = Object.freeze({
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
});

const SINCE_PATTERN = /^(\d+)(m|h|d|w)$/i;

/**
 * Parse a `--since`/`REPORT_SINCE`-style duration string (e.g. "24h", "30m", "7d", "2w")
 * into a millisecond duration.
 * @param {string} sinceStr
 * @returns {number}
 */
function parseSinceMs(sinceStr) {
  const trimmed = String(sinceStr || '').trim();
  const match = SINCE_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid --since value "${sinceStr}". Expected a number followed by m/h/d/w, e.g. "24h", "30m", "7d".`
    );
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * SINCE_UNIT_MS[unit];
}

/**
 * Resolve the effective `--since` string from CLI > env > default, per README/CLI spec.
 * @param {{cliSince?: string, envSince?: string, defaultSince?: string}} params
 * @returns {{raw: string, ms: number, sinceDate: Date}}
 */
function resolveSince({ cliSince, envSince, defaultSince = '24h' } = {}) {
  const raw = cliSince || envSince || defaultSince;
  const ms = parseSinceMs(raw);
  return { raw, ms, sinceDate: new Date(Date.now() - ms) };
}

/**
 * Funnel counts per source_id: stored / duplicate / parse_fail, plus blocked /
 * ignored_by_policy (shown separately, never lumped into parse_fail) and a catch-all
 * "in_progress_or_other" bucket for active/in-flight statuses (discovered/queued/fetching/
 * etc.) so `total` always reconciles.
 *
 * @param {import('pg').Pool} pool
 * @param {{sinceDate: Date, sourceId?: string}} params
 * @returns {Promise<Array<Object>>}
 */
async function getFunnelCounts(pool, { sinceDate, sourceId }) {
  const { rows } = await pool.query(
    `
    SELECT
      source_id,
      COUNT(*) FILTER (WHERE status = 'stored')                          AS stored,
      COUNT(*) FILTER (WHERE status = 'duplicate')                       AS duplicate,
      COUNT(*) FILTER (WHERE status IN ('invalid', 'dead_letter'))       AS parse_fail,
      COUNT(*) FILTER (WHERE status = 'blocked')                         AS blocked,
      COUNT(*) FILTER (WHERE status = 'ignored_by_policy')               AS ignored_by_policy,
      COUNT(*) FILTER (WHERE status NOT IN (
        'stored', 'duplicate', 'invalid', 'dead_letter', 'blocked', 'ignored_by_policy'
      ))                                                                  AS in_progress_or_other,
      COUNT(*)                                                            AS total
    FROM processing_status
    WHERE status_updated_at >= $1
      AND ($2::text IS NULL OR source_id = $2)
    GROUP BY source_id
    ORDER BY source_id
    `,
    [sinceDate, sourceId || null]
  );
  return rows;
}

/**
 * Optional-field fill counts/percentages per source_id, over `articles` touched in the
 * window (see module doc for the `last_seen_at` window choice). Empty string / null / empty
 * JSON array/object all count as "not filled".
 *
 * @param {import('pg').Pool} pool
 * @param {{sinceDate: Date, sourceId?: string}} params
 * @returns {Promise<Array<Object>>}
 */
async function getFieldFillStats(pool, { sinceDate, sourceId }) {
  const fillColumns = REPORT_OPTIONAL_FIELDS.map(
    (field) => `COUNT(*) FILTER (WHERE ${fillExpr(field)}) AS ${field}_filled`
  ).join(',\n      ');

  const { rows } = await pool.query(
    `
    SELECT
      source_id,
      COUNT(*) AS total_articles,
      ${fillColumns}
    FROM articles
    WHERE last_seen_at >= $1
      AND ($2::text IS NULL OR source_id = $2)
    GROUP BY source_id
    ORDER BY source_id
    `,
    [sinceDate, sourceId || null]
  );
  return rows;
}

/**
 * only_in_sitemap counts per source_id (optional section): among `discovered_urls` rows
 * touched in the window, how many distinct (source_id, normalized_url) pairs were seen via
 * a sitemap-like channel (`discovery_channel ILIKE 'sitemap%'`) and *never* via a
 * non-sitemap channel in that same window. Only meaningful for dual-channel sources; still
 * returns rows (possibly zero counts) for every source with discovery activity.
 *
 * @param {import('pg').Pool} pool
 * @param {{sinceDate: Date, sourceId?: string}} params
 * @returns {Promise<Array<Object>>}
 */
async function getOnlyInSitemapStats(pool, { sinceDate, sourceId }) {
  const { rows } = await pool.query(
    `
    WITH windowed AS (
      SELECT source_id, normalized_url, discovery_channel
      FROM discovered_urls
      WHERE last_discovered_at >= $1
        AND ($2::text IS NULL OR source_id = $2)
    ),
    agg AS (
      SELECT
        source_id,
        normalized_url,
        bool_or(discovery_channel ILIKE 'sitemap%')     AS has_sitemap,
        bool_or(discovery_channel NOT ILIKE 'sitemap%')  AS has_non_sitemap
      FROM windowed
      GROUP BY source_id, normalized_url
    )
    SELECT
      source_id,
      COUNT(*)                                                     AS total_urls,
      COUNT(*) FILTER (WHERE has_sitemap)                          AS sitemap_urls,
      COUNT(*) FILTER (WHERE has_sitemap AND NOT has_non_sitemap)  AS only_in_sitemap,
      COUNT(*) FILTER (WHERE has_sitemap AND has_non_sitemap)      AS sitemap_and_other
    FROM agg
    GROUP BY source_id
    ORDER BY source_id
    `,
    [sinceDate, sourceId || null]
  );
  return rows;
}

function pct(numerator, denominator) {
  const num = Number(numerator) || 0;
  const den = Number(denominator) || 0;
  if (den === 0) return null;
  return (num / den) * 100;
}

function formatPct(value) {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

/**
 * Render a simple markdown table. `rows` are arrays already formatted as strings.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
function renderTable(headers, rows) {
  if (rows.length === 0) return '_(no rows)_';
  const headerLine = `| ${headers.join(' | ')} |`;
  const sepLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerLine, sepLine, ...bodyLines].join('\n');
}

/**
 * Turn the three query results into the final markdown/text report printed to stdout.
 *
 * @param {{
 *   since: string,
 *   sinceDate: Date,
 *   generatedAt: Date,
 *   sourceFilter?: string,
 *   funnel: Array<Object>,
 *   fieldFill: Array<Object>,
 *   sitemap: Array<Object>,
 * }} data
 * @returns {string}
 */
function formatReport({ since, sinceDate, generatedAt, sourceFilter, funnel, fieldFill, sitemap }) {
  const lines = [];

  lines.push('# Crawl Report');
  lines.push('');
  lines.push(`- Generated at: ${generatedAt.toISOString()}`);
  lines.push(`- Window: since ${since} (>= ${sinceDate.toISOString()})`);
  lines.push(`- Source filter: ${sourceFilter || '(all sources)'}`);
  lines.push('');

  lines.push('## Funnel (by source_id)');
  lines.push('');
  lines.push(
    '_Window: `processing_status.status_updated_at`. `parse_fail` = `invalid` + `dead_letter` only ' +
      '(`blocked`/`ignored_by_policy` shown separately, never lumped in). `in_progress_or_other` covers ' +
      'active/in-flight statuses (discovered/queued/fetching/...) still mid-pipeline at report time._'
  );
  lines.push('');
  if (funnel.length === 0) {
    lines.push('_No `processing_status` activity in this window._');
  } else {
    lines.push(
      renderTable(
        ['source_id', 'stored', 'duplicate', 'parse_fail', 'blocked', 'ignored_by_policy', 'in_progress/other', 'total'],
        funnel.map((row) => [
          row.source_id,
          row.stored,
          row.duplicate,
          row.parse_fail,
          row.blocked,
          row.ignored_by_policy,
          row.in_progress_or_other,
          row.total,
        ])
      )
    );
  }
  lines.push('');

  lines.push('## Optional field fill % (by source_id)');
  lines.push('');
  lines.push(
    '_Window: `articles.last_seen_at` (bumped on every store pass, insert or update). ' +
      'Empty string / null / empty JSON array or object counts as not filled._'
  );
  lines.push('');
  if (fieldFill.length === 0) {
    lines.push('_No `articles` touched in this window._');
  } else {
    lines.push(
      renderTable(
        ['source_id', 'articles', ...REPORT_OPTIONAL_FIELDS],
        fieldFill.map((row) => [
          row.source_id,
          row.total_articles,
          ...REPORT_OPTIONAL_FIELDS.map((field) =>
            formatPct(pct(row[`${field}_filled`], row.total_articles))
          ),
        ])
      )
    );
  }
  lines.push('');

  lines.push('## only_in_sitemap (optional, by source_id)');
  lines.push('');
  lines.push(
    '_Window: `discovered_urls.last_discovered_at`. Counts normalized URLs seen via a ' +
      "sitemap-like channel (`discovery_channel ILIKE 'sitemap%'`) that did NOT also appear " +
      'via a non-sitemap channel in this window. Only meaningful for dual-channel sources; ' +
      '0 is expected/valid for sitemap-only or listing-only sources._'
  );
  lines.push('');
  if (sitemap.length === 0) {
    lines.push('_No `discovered_urls` activity in this window._');
  } else {
    lines.push(
      renderTable(
        ['source_id', 'total_urls', 'sitemap_urls', 'only_in_sitemap', 'sitemap_and_other'],
        sitemap.map((row) => [
          row.source_id,
          row.total_urls,
          row.sitemap_urls,
          row.only_in_sitemap,
          row.sitemap_and_other,
        ])
      )
    );
  }
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  REPORT_OPTIONAL_FIELDS,
  parseSinceMs,
  resolveSince,
  getFunnelCounts,
  getFieldFillStats,
  getOnlyInSitemapStats,
  formatReport,
};
