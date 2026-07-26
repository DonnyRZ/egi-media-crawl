#!/usr/bin/env node
'use strict';

// One-off crawl entrypoint (F6). Runs discover -> fetch -> parse -> store for a single
// source directly (no BullMQ/Redis involved), so a fixture-backed source like `detik`
// can be exercised end-to-end with just Postgres running.
//
// Usage:
//   node scripts/crawl-once.js --source=detik
//   npm run crawl:once -- --source=detik   (source defaults to "detik")
//
// Limit (Sprint 0 live-crawl safety, see README.md "CRAWL_LIVE"): pass --limit=N or set
// CRAWL_LIMIT=N to cap how many discovered URLs get processed. Required (fail-fast) when
// CRAWL_LIVE=true, e.g.:
//   CRAWL_LIVE=true npm run crawl:once -- --source=detik --limit=2

require('dotenv').config();

const { getAdapter } = require('../src/adapters');
const { runPipeline, resolveDiscoverLimit } = require('../src/core');
const { fetchArticleHtml, isLiveCrawlEnabled } = require('../src/workers/lib/fetchHtml');
const { upsertSource } = require('../src/db/sources');
const { storeParsedArticle, upsertProcessingStatus } = require('../src/db/articles');
const { recordDiscoveredUrl } = require('../src/db/discoveredUrls');
const { PROCESSING_STATUS } = require('../src/core/status');
const { pool } = require('../src/db');

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

function maskConnectionString(value) {
  return value.replace(/:\/\/([^:]+):([^@]*)@/, '://$1:****@');
}

/**
 * `pg`/Node's `net` module surface connection failures (e.g. Postgres not running) as an
 * `AggregateError` with an empty top-level `.message` and the real reason(s) nested under
 * `.errors`. Unwrap that so the CLI's error output is actually actionable.
 * @param {Error} err
 * @returns {string}
 */
function describeError(err) {
  if (err && err.message) return err.message;
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map((e) => e.message || String(e)).join('; ');
  }
  return String(err);
}

/**
 * Fail fast with a clear, actionable message instead of letting `pg` hang/retry when
 * DATABASE_URL is missing or Postgres isn't reachable.
 */
async function assertDatabaseReady() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, set DATABASE_URL, then re-run ' +
        '`npm run crawl:once`.'
    );
  }

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(
      `Could not connect to Postgres at ${maskConnectionString(process.env.DATABASE_URL)}. ` +
        `Make sure the database is running and migrated (npm run migrate). Original error: ${describeError(err)}`
    );
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const sourceId = args.source || 'detik';

  // Fail fast on a malformed/missing limit before touching the network or the db — see
  // src/core/crawlLimit.js for the exact rule (required when CRAWL_LIVE=true).
  const liveCrawl = isLiveCrawlEnabled();
  const limit = resolveDiscoverLimit({ explicitLimit: args.limit, liveCrawl });

  await assertDatabaseReady();

  const adapter = getAdapter(sourceId);
  const profile = adapter.getSourceProfile();

  await upsertSource(profile);
  console.log(`[crawl-once] upserted source "${sourceId}" (${profile.display_name})`);

  // Gate discovery on CRAWL_LIVE the same way fetchArticleHtml() gates the fetch step
  // (see src/workers/lib/fetchHtml.js). Not every adapter reads CRAWL_LIVE itself —
  // e.g. detik's raw discover() only skips its live indeks fetch when `ctx.fixtureOnly`
  // is set — so without this, a fixture-only run (CRAWL_LIVE unset) could still hit the
  // network during discovery. `liveDiscover` is the flag suara's adapter reads; passing
  // both covers every current adapter's convention without adapter-specific branching.
  // `limit` is passed through as `ctx.limit` so each adapter's own discover() also caps
  // its live fetch/pagination work (not just the post-hoc slice below).
  const discovered = await adapter.discover({
    sourceId,
    sourceProfile: profile,
    fixtureOnly: !liveCrawl,
    liveDiscover: liveCrawl,
    limit,
  });

  // Defense-in-depth: cap the item list here too, regardless of whether the adapter's own
  // discover() honored `ctx.limit` internally. Also lets `--limit`/CRAWL_LIMIT cap the
  // fixture-listing path (CRAWL_LIVE unset), which is optional but harmless.
  const items = typeof limit === 'number' ? discovered.slice(0, limit) : discovered;

  console.log(
    `[crawl-once] discovered ${discovered.length} candidate url(s) via adapter.discover()` +
      (items.length !== discovered.length ? `, capped to ${items.length} by limit=${limit}` : '')
  );

  const results = [];

  for (const item of items) {
    if (!item || !item.url) continue;

    try {
      await recordDiscoveredUrl({
        sourceId,
        rawUrl: item.url,
        normalizedUrl: (item.metadata && item.metadata.normalizedUrlHint) || item.url,
        discoveryChannel: item.channel,
        listingTitle: item.title_hint,
        publishedHint: item.published_hint,
      });
      await upsertProcessingStatus({
        sourceId,
        normalizedUrl: item.url,
        status: PROCESSING_STATUS.DISCOVERED,
        reason: `discovery_channel_${item.channel || 'unknown'}`,
      });
    } catch (err) {
      console.warn(`[crawl-once] could not record discovery bookkeeping for ${item.url}: ${err.message}`);
    }

    // fetch -> parse -> contentHash -> store, all via the shared core pipeline
    // (fetchArticleHtml is fixture-first for `detik`, see src/workers/lib/fetchHtml.js).
    const result = await runPipeline({
      adapter,
      fetchFn: (url) => fetchArticleHtml(sourceId, url),
      storeFn: storeParsedArticle,
      url: item.url,
      ctx: { sourceId, sourceProfile: profile },
    });

    results.push(result);
    console.log(
      `[crawl-once] ${item.url} -> ${result.status}${result.reason ? ` (${result.reason})` : ''}`
    );
  }

  console.log('\n[crawl-once] summary:');
  for (const result of results) {
    const title = (result.article && result.article.title) || '(no title)';
    console.log(`  - [${result.status}] ${title}\n      ${result.requestedUrl}`);
  }

  const storedCount = results.filter((r) => r.status === 'stored' || r.status === 'duplicate').length;
  console.log(`\n[crawl-once] done. ${storedCount}/${results.length} article(s) stored/deduped for "${sourceId}".`);
}

run()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`[crawl-once] failed: ${describeError(err)}`);
    process.exitCode = 1;
    await pool.end().catch(() => {});
  });
