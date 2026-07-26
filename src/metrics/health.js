'use strict';

/**
 * Threshold evaluation for `npm run report:check` (Sprint 14, S14-A).
 *
 * Safe defaults: an empty / idle window never fails. Thresholds only fire when there is
 * enough evidence of crawl activity (terminal outcomes, discoveries, or an explicit
 * "require stored" flag). Configure via env — see `resolveHealthThresholds()`.
 */

/**
 * @typedef {{
 *   parseFailMaxRatio: number,
 *   parseFailMinTotal: number,
 *   parseFailMaxCount: number | null,
 *   requireStored: boolean,
 *   minDiscoveriesForStored: number,
 * }} HealthThresholds
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   failures: string[],
 *   totals: {
 *     stored: number,
 *     duplicate: number,
 *     parse_fail: number,
 *     blocked: number,
 *     ignored_by_policy: number,
 *     in_progress_or_other: number,
 *     total: number,
 *     discovered_urls: number,
 *     success: number,
 *     terminal: number,
 *   },
 *   thresholds: HealthThresholds,
 * }} HealthResult
 */

function toNonNegInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Expected a non-negative number, got "${raw}"`);
  }
  return Math.floor(n);
}

function toRatio(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`Expected a ratio in [0, 1], got "${raw}"`);
  }
  return n;
}

function toBool(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Expected a boolean-ish value, got "${raw}"`);
}

/**
 * Resolve health thresholds from env (or an explicit overrides object for tests).
 *
 * Defaults (no false-alarm on empty fresh DB):
 * - `REPORT_PARSE_FAIL_MAX_RATIO=0.5` — fail when parse_fail / (stored+duplicate+parse_fail) >= ratio
 * - `REPORT_PARSE_FAIL_MIN_TOTAL=5` — ratio check only applies when that denominator is large enough
 * - `REPORT_PARSE_FAIL_MAX_COUNT` unset — optional absolute parse_fail cap (disabled when unset)
 * - `REPORT_REQUIRE_STORED=0` — when 1, require stored+duplicate > 0 (alarms on idle windows)
 * - `REPORT_MIN_DISCOVERIES=0` — when >0, require stored+duplicate > 0 if discovered_urls >= N
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {HealthThresholds}
 */
function resolveHealthThresholds(env = process.env) {
  const parseFailMaxCountRaw = env.REPORT_PARSE_FAIL_MAX_COUNT;
  let parseFailMaxCount = null;
  if (parseFailMaxCountRaw !== undefined && String(parseFailMaxCountRaw).trim() !== '') {
    parseFailMaxCount = toNonNegInt(parseFailMaxCountRaw, 0);
  }

  return {
    parseFailMaxRatio: toRatio(env.REPORT_PARSE_FAIL_MAX_RATIO, 0.5),
    parseFailMinTotal: toNonNegInt(env.REPORT_PARSE_FAIL_MIN_TOTAL, 5),
    parseFailMaxCount,
    requireStored: toBool(env.REPORT_REQUIRE_STORED, false),
    minDiscoveriesForStored: toNonNegInt(env.REPORT_MIN_DISCOVERIES, 0),
  };
}

function sumFunnel(funnelRows) {
  const totals = {
    stored: 0,
    duplicate: 0,
    parse_fail: 0,
    blocked: 0,
    ignored_by_policy: 0,
    in_progress_or_other: 0,
    total: 0,
  };
  for (const row of funnelRows || []) {
    totals.stored += Number(row.stored) || 0;
    totals.duplicate += Number(row.duplicate) || 0;
    totals.parse_fail += Number(row.parse_fail) || 0;
    totals.blocked += Number(row.blocked) || 0;
    totals.ignored_by_policy += Number(row.ignored_by_policy) || 0;
    totals.in_progress_or_other += Number(row.in_progress_or_other) || 0;
    totals.total += Number(row.total) || 0;
  }
  return totals;
}

function sumDiscoveredUrls(sitemapRows) {
  let n = 0;
  for (const row of sitemapRows || []) {
    n += Number(row.total_urls) || 0;
  }
  return n;
}

/**
 * Evaluate funnel (+ optional discovery) rows against thresholds.
 *
 * @param {{
 *   funnel?: Array<Object>,
 *   sitemap?: Array<Object>,
 *   thresholds?: HealthThresholds,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 * }} params
 * @returns {HealthResult}
 */
function evaluateReportHealth({ funnel = [], sitemap = [], thresholds, env } = {}) {
  const resolved = thresholds || resolveHealthThresholds(env || process.env);
  const funnelTotals = sumFunnel(funnel);
  const discoveredUrls = sumDiscoveredUrls(sitemap);
  const success = funnelTotals.stored + funnelTotals.duplicate;
  const terminal = success + funnelTotals.parse_fail;

  const totals = {
    ...funnelTotals,
    discovered_urls: discoveredUrls,
    success,
    terminal,
  };

  /** @type {string[]} */
  const failures = [];

  // Absolute parse_fail cap (opt-in via env).
  if (resolved.parseFailMaxCount !== null && funnelTotals.parse_fail > resolved.parseFailMaxCount) {
    failures.push(
      `parse_fail count ${funnelTotals.parse_fail} exceeds REPORT_PARSE_FAIL_MAX_COUNT=${resolved.parseFailMaxCount}`
    );
  }

  // Ratio spike: only when there are enough terminal outcomes (empty/idle → skip).
  if (resolved.parseFailMinTotal > 0 && terminal >= resolved.parseFailMinTotal) {
    const ratio = funnelTotals.parse_fail / terminal;
    if (ratio >= resolved.parseFailMaxRatio) {
      failures.push(
        `parse_fail ratio ${(ratio * 100).toFixed(1)}% ` +
          `(${funnelTotals.parse_fail}/${terminal}) >= REPORT_PARSE_FAIL_MAX_RATIO=${resolved.parseFailMaxRatio} ` +
          `(min total ${resolved.parseFailMinTotal})`
      );
    }
  }

  // Zero-success when terminal failures exist (safe on empty: all zeros → skip).
  if (success === 0 && funnelTotals.parse_fail > 0) {
    failures.push(
      `stored+duplicate=0 but parse_fail=${funnelTotals.parse_fail} ` +
        `(pipeline produced only failures in this window)`
    );
  }

  // Explicit "we expect stores" (alarms on idle — off by default).
  if (resolved.requireStored && success === 0) {
    failures.push('REPORT_REQUIRE_STORED=1 but stored+duplicate=0 in this window');
  }

  // Discoveries present but nothing stored/duplicated (opt-in via REPORT_MIN_DISCOVERIES>0).
  if (
    resolved.minDiscoveriesForStored > 0 &&
    discoveredUrls >= resolved.minDiscoveriesForStored &&
    success === 0
  ) {
    failures.push(
      `discovered_urls=${discoveredUrls} >= REPORT_MIN_DISCOVERIES=${resolved.minDiscoveriesForStored} ` +
        'but stored+duplicate=0'
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    totals,
    thresholds: resolved,
  };
}

/**
 * One-line summary for stderr after the markdown report.
 * @param {HealthResult} result
 * @returns {string}
 */
function formatHealthSummary(result) {
  const t = result.totals;
  const th = result.thresholds;
  const lines = [
    `[report-check] window totals: stored=${t.stored} duplicate=${t.duplicate} ` +
      `parse_fail=${t.parse_fail} discovered_urls=${t.discovered_urls} ` +
      `terminal=${t.terminal} success=${t.success}`,
    `[report-check] thresholds: parseFailMaxRatio=${th.parseFailMaxRatio} ` +
      `parseFailMinTotal=${th.parseFailMinTotal} ` +
      `parseFailMaxCount=${th.parseFailMaxCount === null ? '(off)' : th.parseFailMaxCount} ` +
      `requireStored=${th.requireStored ? 1 : 0} ` +
      `minDiscoveries=${th.minDiscoveriesForStored}`,
  ];
  if (result.ok) {
    lines.push('[report-check] OK');
  } else {
    lines.push(`[report-check] FAIL (${result.failures.length}):`);
    for (const f of result.failures) {
      lines.push(`  - ${f}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  resolveHealthThresholds,
  evaluateReportHealth,
  formatHealthSummary,
  sumFunnel,
  sumDiscoveredUrls,
};
