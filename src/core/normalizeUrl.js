'use strict';

/**
 * URL normalization for deduplication and storage (playbook §16 "Normalisasi URL dan
 * Canonical URL").
 *
 * IMPORTANT: this is a pure, offline string transform. It does NOT resolve `rel=canonical`,
 * does not follow redirects, and does not know which query parameters matter for a given
 * source — those are separate concerns (see §16.4-16.6 and the pipeline/adapter layers).
 */

const DEFAULT_TRACKING_PARAM_PREFIXES = ['utm_'];

// Common cross-source tracking params (playbook §16.3). Kept intentionally small/generic;
// sources with extra tracking params should pass `extraTrackingParams` via their
// SourceProfile.normalizeUrlOptions rather than growing this list.
const DEFAULT_TRACKING_PARAMS = [
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'refsrc',
  'spm',
];

/**
 * @typedef {Object} NormalizeUrlOptions
 * @property {string} [baseUrl] - Base URL used to resolve relative URLs.
 * @property {'strip'|'keep'} [trailingSlash='strip'] - Trailing slash policy for the path.
 *   The root path "/" is always preserved regardless of this setting.
 * @property {string[]} [extraTrackingParams] - Additional query parameter names to strip,
 *   on top of the built-in defaults (utm_*, fbclid, gclid, ...).
 * @property {string[]} [keepParams] - Query parameter names that must never be stripped,
 *   even if they would otherwise match a tracking-param rule. Use this for params that
 *   affect content, e.g. ["id", "article_id", "page", "lang", "edition"] (§16.3).
 * @property {boolean} [forceHttps=false] - If true, unconditionally rewrite http:// to
 *   https://. Only enable this for sources proven to redirect http->https equivalently
 *   (§16.2 step 3 explicitly warns against doing this blindly).
 */

/**
 * Normalize an article URL.
 *
 * Steps applied (subset of playbook §16.2 that is safe to do generically, without per-source
 * knowledge):
 *   1. Resolve relative URLs against `options.baseUrl`, if given.
 *   2. Lowercase the scheme and hostname (path/query casing is preserved as-is).
 *   3. Optionally force http -> https (`forceHttps`, default off).
 *   4. Strip default ports (80 for http, 443 for https).
 *   5. Strip the fragment/hash.
 *   6. Strip known tracking parameters (utm_*, fbclid, gclid, ...), minus anything in
 *      `keepParams`, plus anything in `extraTrackingParams`.
 *   7. Sort the remaining query parameters alphabetically by key for stable comparisons.
 *   8. Apply the trailing-slash policy to the path (default: strip, except root "/").
 *
 * Deliberately NOT done here (left to adapters/pipeline, which have source-specific context):
 *   - canonicalization via rel=canonical / og:url (§16.4-16.5)
 *   - deciding which non-tracking query params are safe to drop for a given source
 *   - www vs non-www host unification (varies per source; do it via a source-specific
 *     `adapter.normalizeUrl` layered on top of this function if needed)
 *
 * @param {string} rawUrl
 * @param {NormalizeUrlOptions} [options]
 * @returns {string} normalized absolute URL string
 */
function normalizeUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new TypeError('normalizeUrl: rawUrl must be a non-empty string');
  }

  const {
    baseUrl,
    trailingSlash = 'strip',
    extraTrackingParams = [],
    keepParams = [],
    forceHttps = false,
  } = options;

  const parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);

  parsed.hash = '';
  parsed.protocol = parsed.protocol.toLowerCase();

  if (forceHttps && parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  }

  parsed.hostname = parsed.hostname.toLowerCase();

  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  const keepSet = new Set(keepParams.map((p) => p.toLowerCase()));
  const trackingParamNames = new Set(
    [...DEFAULT_TRACKING_PARAMS, ...extraTrackingParams].map((p) => p.toLowerCase())
  );

  const isTrackingParam = (name) => {
    const lower = name.toLowerCase();
    if (keepSet.has(lower)) return false;
    if (trackingParamNames.has(lower)) return true;
    return DEFAULT_TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
  };

  const remainingParams = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!isTrackingParam(key)) {
      remainingParams.push([key, value]);
    }
  }
  remainingParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  parsed.search = '';
  for (const [key, value] of remainingParams) {
    parsed.searchParams.append(key, value);
  }

  if (trailingSlash === 'strip' && parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  }

  return parsed.toString();
}

module.exports = {
  normalizeUrl,
  DEFAULT_TRACKING_PARAMS: [...DEFAULT_TRACKING_PARAMS],
  DEFAULT_TRACKING_PARAM_PREFIXES: [...DEFAULT_TRACKING_PARAM_PREFIXES],
};
