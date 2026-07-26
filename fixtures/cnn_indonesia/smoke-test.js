#!/usr/bin/env node
'use strict';

// Offline smoke test for the CNN Indonesia adapter (Sprint 3, S3-A).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S3-D owns that).
//
// Usage: node fixtures/cnn_indonesia/smoke-test.js
//   CRAWL_LIVE=true node fixtures/cnn_indonesia/smoke-test.js   # also exercises live discover()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'cnn_indonesia', 'coreAdapter'));
const rawCnnIndonesia = require(path.join('..', '..', 'src', 'adapters', 'cnn_indonesia'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[cnn_indonesia smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[cnn_indonesia smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'cnn_indonesia', sourceProfile: profile });
  console.log(`[cnn_indonesia smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}`);
    console.log(`      external_id: ${item.external_id}  category_hint: ${item.category_hint}`);
    console.log(`      published_hint: ${item.published_hint}`);
  }

  const isArticleChecks = [
    discoveryItems[0] && discoveryItems[0].url,
    'https://www.cnnindonesia.com/indeks',
    'https://www.cnnindonesia.com/tag/ojk',
    'https://tv.cnnindonesia.com/20260724100745-78-1234567/out-of-scope-subdomain',
  ].filter(Boolean);
  console.log('\n[cnn_indonesia smoke] --- isArticleUrl() checks ---');
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }

  console.log('\n[cnn_indonesia smoke] --- parse() (fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0] && discoveryItems[0].url });
  console.log(`[cnn_indonesia smoke] title: ${article.title}`);
  console.log(`[cnn_indonesia smoke] summary: ${article.summary}`);
  console.log(`[cnn_indonesia smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[cnn_indonesia smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[cnn_indonesia smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[cnn_indonesia smoke] published_at: ${article.published_at}`);
  console.log(`[cnn_indonesia smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[cnn_indonesia smoke] author_name: ${article.author_name}`);
  console.log(`[cnn_indonesia smoke] category: ${article.category}`);
  console.log(`[cnn_indonesia smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[cnn_indonesia smoke] language: ${article.language}`);
  console.log(`[cnn_indonesia smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[cnn_indonesia smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (article.content_text.includes('Lihat Juga')) {
    throw new Error('expected "Lihat Juga" noise to be stripped from content_text');
  }
  if (article.content_text.includes('SCROLL TO CONTINUE')) {
    throw new Error('expected parallax ad noise to be stripped from content_text');
  }
  if (!article.summary) throw new Error('expected summary from fixture JSON-LD/og:description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture');
  if (!Array.isArray(article.tags) || article.tags.length === 0) {
    throw new Error('expected tags from the "TOPIK TERKAIT" aside');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[cnn_indonesia smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawCnnIndonesia.discoverLive({ limit: 5 });
    console.log(`[cnn_indonesia smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[cnn_indonesia smoke] OK');
}

main().catch((err) => {
  console.error('[cnn_indonesia smoke] FAILED:', err);
  process.exitCode = 1;
});
