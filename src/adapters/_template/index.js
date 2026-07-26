'use strict';

/**
 * Adapter template / contract documentation.
 *
 * Every source adapter (see `src/adapters/<sourceId>/index.js`) MUST export an
 * object shaped like this module. This is the contract shared with the core
 * crawl pipeline (discovery workers, article workers, scheduler — owned by F3/F4).
 * Do NOT change the shape of the exported methods; only the implementation
 * inside each adapter differs.
 *
 * Copy this file into `src/adapters/<sourceId>/index.js` and fill in the
 * `TODO` sections to bootstrap a new source.
 */

/**
 * @typedef {Object} SourceProfile
 * @property {string} sourceId - Stable slug, e.g. "detik". Matches the adapter folder name.
 * @property {string} displayName - Human readable name, e.g. "Detikcom".
 * @property {string} baseUrl - Canonical root URL for the source, e.g. "https://www.detik.com/".
 * @property {string} timezone - IANA timezone used to interpret publish timestamps, e.g. "Asia/Jakarta".
 * @property {number} crawlIntervalMinutes - How often discovery should run for this source.
 * @property {number} overlapHours - How far back discovery should look on each run, to tolerate
 *   missed/late runs without losing articles (overlap window, in hours).
 * @property {boolean} enabled - Whether the registry should load/schedule this source.
 */

/**
 * @typedef {Object} DiscoveredItem
 * @property {string} rawUrl - URL as found on the listing/index page, before normalization.
 * @property {string} [normalizedUrl] - Canonical form of the URL (query params stripped, etc.),
 *   if the adapter can determine it cheaply during discovery.
 * @property {string} discoveryChannel - Where this URL came from, e.g. "homepage", "rss", "sitemap",
 *   "fixture" (used by stub/test adapters that read from local fixtures instead of the network).
 * @property {string} [listingTitle] - Title/headline as shown on the listing page, if available.
 * @property {string} [publishedHint] - Best-effort publish time/date string as seen on the listing
 *   page (not authoritative — `parse()` should extract the real timestamp from the article page).
 */

/**
 * @typedef {Object} DiscoverResult
 * @property {DiscoveredItem[]} items
 */

/**
 * @typedef {Object} ParsedArticle
 * @property {string} sourceId
 * @property {string} url - Canonical URL of the article.
 * @property {string} title
 * @property {string} [author]
 * @property {string} [publishedAt] - ISO 8601 timestamp (UTC) of publication, if determinable.
 * @property {string} [updatedAt] - ISO 8601 timestamp (UTC) of last update, if available.
 * @property {string[]} paragraphs - Body content split into paragraphs, in reading order.
 * @property {string} [rawHtml] - Original HTML that was parsed (optional, useful for debugging).
 */

/**
 * @typedef {Object} AdapterContext
 * @property {SourceProfile} [sourceProfile] - Convenience access to this adapter's own profile.
 * @property {Object} [logger] - Optional logger injected by the core (falls back to console).
 * @property {Object} [http] - Optional HTTP client injected by the core (adapter may also bring
 *   its own, e.g. axios, for real network sources).
 */

module.exports = {
  /**
   * Returns static metadata describing this source. Must be a plain, synchronous
   * function (no network calls) — the registry calls this eagerly at load time.
   *
   * @returns {SourceProfile}
   */
  getSourceProfile() {
    throw new Error('_template adapter: getSourceProfile() not implemented');
  },

  /**
   * Cheap, synchronous heuristic to decide whether a given absolute URL looks
   * like an article (as opposed to a listing/category/tag/homepage URL).
   * Used to filter discovery results and to validate URLs from other channels
   * (e.g. sitemaps) before queuing them for parsing.
   *
   * @param {string} url
   * @returns {boolean}
   */
  isArticleUrl(url) {
    throw new Error('_template adapter: isArticleUrl() not implemented');
  },

  /**
   * Finds candidate article URLs for this source (homepage/section listings,
   * RSS/sitemap, etc). Real adapters fetch over the network; stub/test adapters
   * may return fixture URLs with `discoveryChannel: "fixture"`.
   *
   * @param {AdapterContext} ctx
   * @returns {Promise<DiscoverResult>}
   */
  async discover(ctx) {
    throw new Error('_template adapter: discover() not implemented');
  },

  /**
   * Parses a single article's HTML into a normalized ParsedArticle-like object.
   * Must not perform network I/O itself — `html` is provided by the caller
   * (already fetched, or read from a fixture file).
   *
   * @param {string} html
   * @param {AdapterContext} ctx
   * @returns {Promise<ParsedArticle>}
   */
  async parse(html, ctx) {
    throw new Error('_template adapter: parse() not implemented');
  },
};
