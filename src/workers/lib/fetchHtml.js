'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Shared "fetch a single article's HTML" implementation used as the `fetchFn` injected
 * into `runPipeline` (src/core/pipeline.js never performs HTTP itself) by both the
 * `crawl-fetch`/`crawl-parse` workers (src/workers/handlers/*.js) and
 * `scripts/crawl-once.js`.
 *
 * Per-source fixture mode: sources listed in FIXTURE_PATHS always read their bundled
 * fixture HTML instead of making a live HTTP request — this is what keeps the pilot
 * sources (detik/suara/viva) a safe, network-free dry run. Set CRAWL_LIVE=true to opt
 * into live HTTP for those sources anyway; default is fixture-first so nothing
 * accidentally scrapes a live site. Every pilot adapter must have an entry here —
 * otherwise `crawl-once`/the `crawl-fetch` worker will silently fall through to a real
 * `axios.get()` against whatever URL `adapter.discover()` returned (fixture URLs are
 * fake, so that just means a wasted/failing live request, but it defeats the point of
 * a fixture-only E2E run).
 *
 * Sprint 3 sources (cnn_indonesia, liputan6) follow the exact same fixture-first rule.
 * Sprint 3b adds `tirto`, same rule again.
 * Sprint 4 adds `tempo`, `kumparan`, and `jawa_pos`, same rule again.
 * Sprint 5 adds `okezone` and `sindonews`, same rule again.
 * Sprint 6a adds `idn_times`, `republika`, and `media_indonesia`, same rule again.
 * Sprint 6b adds `merdeka`, `beritasatu`, and `tribunnews`, same rule again.
 *
 * Sprint 7 (S7-A): `beritasatu`/`tribunnews` are **restricted** — their own adapters
 * (`src/adapters/beritasatu/index.js` / `src/adapters/tribunnews/index.js`) already
 * verified live that the plain `CRAWLER_UA` product token below gets an HTTP 403 from
 * CloudFront on `discover()`'s own live fetches, and use a browser-class `LIVE_UA`
 * instead (Chrome-shaped, with this crawler's own product token honestly appended —
 * NOT a spoofed Googlebot/other-crawler identity). This module's live `axios.get()` for
 * `fetchArticleHtml()` was still sending the bare `CRAWLER_UA`, which 403'd on article
 * fetch even after discovery succeeded — see `resolveUserAgent()` below, which reuses
 * each adapter's own exported `LIVE_UA` (imported directly, not duplicated as a second
 * string) so the two can never drift apart. A small, env-overridable delay
 * (`restrictedFetchDelay()`) is also applied before those two sources' live requests as
 * a minimal, good-citizen rate limit — see that function for details. Every other
 * source is unaffected: default UA/no added delay.
 */

const FIXTURE_PATHS = {
  detik: path.join(__dirname, '..', '..', '..', 'fixtures', 'detik', 'sample-article.html'),
  suara: path.join(__dirname, '..', '..', '..', 'fixtures', 'suara', 'sample-article.html'),
  viva: path.join(__dirname, '..', '..', '..', 'fixtures', 'viva', 'sample-article.html'),
  cnn_indonesia: path.join(__dirname, '..', '..', '..', 'fixtures', 'cnn_indonesia', 'sample-article.html'),
  liputan6: path.join(__dirname, '..', '..', '..', 'fixtures', 'liputan6', 'sample-article.html'),
  tirto: path.join(__dirname, '..', '..', '..', 'fixtures', 'tirto', 'sample-article.html'),
  tempo: path.join(__dirname, '..', '..', '..', 'fixtures', 'tempo', 'sample-article.html'),
  kumparan: path.join(__dirname, '..', '..', '..', 'fixtures', 'kumparan', 'sample-article.html'),
  jawa_pos: path.join(__dirname, '..', '..', '..', 'fixtures', 'jawa_pos', 'sample-article.html'),
  okezone: path.join(__dirname, '..', '..', '..', 'fixtures', 'okezone', 'sample-article.html'),
  sindonews: path.join(__dirname, '..', '..', '..', 'fixtures', 'sindonews', 'sample-article.html'),
  idn_times: path.join(__dirname, '..', '..', '..', 'fixtures', 'idn_times', 'sample-article.html'),
  republika: path.join(__dirname, '..', '..', '..', 'fixtures', 'republika', 'sample-article.html'),
  media_indonesia: path.join(__dirname, '..', '..', '..', 'fixtures', 'media_indonesia', 'sample-article.html'),
  merdeka: path.join(__dirname, '..', '..', '..', 'fixtures', 'merdeka', 'sample-article.html'),
  beritasatu: path.join(__dirname, '..', '..', '..', 'fixtures', 'beritasatu', 'sample-article.html'),
  tribunnews: path.join(__dirname, '..', '..', '..', 'fixtures', 'tribunnews', 'sample-article.html'),
};

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';

// Restricted-assessment sources (see module header "Sprint 7"): each adapter's own raw
// `index.js` already defines + exports a browser-class `LIVE_UA` (env-overridable there,
// via `BERITASATU_LIVE_UA` / `TRIBUNNEWS_LIVE_UA` — see docs/RESTRICTED_UA_POLICY.md §4)
// that its own `discover()` verified live gets HTTP 200 where the bare `CRAWLER_UA` above
// 403s. Imported directly (not re-declared as a second literal string here) so this
// module's live article fetch can never silently drift out of sync with what the adapter
// itself uses/documents.
const RESTRICTED_LIVE_UA_BY_SOURCE = {
  beritasatu: require('../../adapters/beritasatu').LIVE_UA,
  tribunnews: require('../../adapters/tribunnews').LIVE_UA,
};

// Minimal, env-overridable good-citizen delay applied before a live request to a
// restricted source (see module header "Sprint 7") — not a full token-bucket/limiter (the
// queue-worker path already has one, see src/queue/rateLimits.js), just a small pause so a
// tight discover->fetch loop (e.g. `scripts/crawl-once.js`, which has no delay of its own
// between items) doesn't hammer these two CloudFront-protected sites back-to-back.
const DEFAULT_RESTRICTED_FETCH_DELAY_MS = 800; // within the requested 500-1500ms range
const RESTRICTED_FETCH_DELAY_MS = Number(process.env.RESTRICTED_LIVE_FETCH_DELAY_MS) || DEFAULT_RESTRICTED_FETCH_DELAY_MS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} sourceId
 * @returns {string} the browser-class `LIVE_UA` for a restricted source, or the shared
 *   `CRAWLER_UA` for every other (unrestricted) source — see module header "Sprint 7".
 */
function resolveUserAgent(sourceId) {
  return RESTRICTED_LIVE_UA_BY_SOURCE[sourceId] || CRAWLER_UA;
}

/**
 * @param {string} sourceId
 * @returns {Promise<void>} resolves after `RESTRICTED_FETCH_DELAY_MS` if `sourceId` is a
 *   restricted source (see module header "Sprint 7"), otherwise resolves immediately.
 */
async function restrictedFetchDelay(sourceId) {
  if (RESTRICTED_LIVE_UA_BY_SOURCE[sourceId]) {
    await sleep(RESTRICTED_FETCH_DELAY_MS);
  }
}

function isLiveCrawlEnabled() {
  return process.env.CRAWL_LIVE === 'true';
}

/**
 * @param {string} sourceId
 * @returns {boolean}
 */
function shouldUseFixture(sourceId) {
  return Boolean(FIXTURE_PATHS[sourceId]) && !isLiveCrawlEnabled();
}

/**
 * @param {string} sourceId
 * @param {string} url
 * @returns {Promise<import('../../core/types').FetchResult>}
 */
async function fetchArticleHtml(sourceId, url) {
  const startedAt = new Date();
  const timing = () => ({
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  });

  if (shouldUseFixture(sourceId)) {
    const body = fs.readFileSync(FIXTURE_PATHS[sourceId], 'utf8');
    return {
      status: 200,
      finalUrl: url,
      body,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      timing: timing(),
      fromCache: true,
    };
  }

  await restrictedFetchDelay(sourceId);

  const response = await axios.get(url, {
    headers: { 'User-Agent': resolveUserAgent(sourceId) },
    timeout: 15000,
    validateStatus: () => true,
    responseType: 'text',
  });

  return {
    status: response.status,
    finalUrl: (response.request && response.request.res && response.request.res.responseUrl) || url,
    body: typeof response.data === 'string' ? response.data : String(response.data),
    headers: { 'content-type': response.headers && response.headers['content-type'] },
    timing: timing(),
  };
}

module.exports = {
  FIXTURE_PATHS,
  shouldUseFixture,
  isLiveCrawlEnabled,
  fetchArticleHtml,
  // exported for smoke scripts / unit tests / debugging the restricted-source UA + rate
  // behavior in isolation (see module header "Sprint 7").
  resolveUserAgent,
  restrictedFetchDelay,
  RESTRICTED_LIVE_UA_BY_SOURCE,
  RESTRICTED_FETCH_DELAY_MS,
};
