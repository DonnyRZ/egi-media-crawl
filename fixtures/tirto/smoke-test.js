#!/usr/bin/env node
'use strict';

// Offline smoke test for the Tirto.id adapter (Sprint 3, S3b).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S3b-D owns that).
//
// Usage: node fixtures/tirto/smoke-test.js
//   CRAWL_LIVE=true node fixtures/tirto/smoke-test.js   # also exercises live discover()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'tirto', 'coreAdapter'));
const rawTirto = require(path.join('..', '..', 'src', 'adapters', 'tirto'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[tirto smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[tirto smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'tirto', sourceProfile: profile, limit: 8 });
  console.log(`[tirto smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the fixture listing');
  }

  console.log('\n[tirto smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://tirto.id/indeks',
    'https://tirto.id/bisnis-tirto',
    'https://tirto.id/visual-tirto',
    'https://tirto.id/rilis-pers',
    'https://tirto.id/pikir-dua-kali',
    'https://tirto.id/bisnis-tirto/insider/ekonomi',
    'https://tirto.id/author/contoh-reporter',
    'https://diajeng.id/contoh-artikel-diajeng-hzZZ',
    'https://www.tirto.id/contoh-judul-berita-tirto-pertama-hzAA',
  ];
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://tirto.id/bisnis-tirto')) {
    throw new Error('expected a tirto.id section-root URL (/bisnis-tirto) to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://tirto.id/pikir-dua-kali')) {
    throw new Error('expected the /pikir-dua-kali section-root URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://tirto.id/bisnis-tirto/insider/ekonomi')) {
    throw new Error('expected a multi-segment category URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://diajeng.id/contoh-artikel-diajeng-hzZZ')) {
    throw new Error('expected the out-of-scope diajeng.id domain to be excluded');
  }
  if (!coreAdapter.isArticleUrl('https://www.tirto.id/contoh-judul-berita-tirto-pertama-hzAA')) {
    throw new Error('expected the www.tirto.id alias host to still be recognized as in-scope');
  }

  console.log('\n[tirto smoke] --- parse() (fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0].url });
  console.log(`[tirto smoke] title: ${article.title}`);
  console.log(`[tirto smoke] summary: ${article.summary}`);
  console.log(`[tirto smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[tirto smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[tirto smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[tirto smoke] published_at: ${article.published_at}`);
  console.log(`[tirto smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[tirto smoke] author_name: ${article.author_name}`);
  console.log(`[tirto smoke] category: ${article.category}`);
  console.log(`[tirto smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[tirto smoke] language: ${article.language}`);
  console.log(`[tirto smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[tirto smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (article.content_text.includes('Baca juga')) {
    throw new Error('expected "Baca juga" noise to be stripped from content_text');
  }
  if (article.content_text.includes('keterangan foto')) {
    throw new Error('expected figcaption noise to be stripped from content_text');
  }
  if (!article.content_text.includes('Contoh Subjudul di Tengah Artikel')) {
    throw new Error('expected the in-body <h2> subheading to be kept in content_text');
  }
  if (!article.summary) throw new Error('expected summary from fixture og:description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture og:image');
  if (!article.published_at) throw new Error('expected published_at parsed from the DOM "Terbit ..." byline');
  if (!article.updated_at_source) throw new Error('expected updated_at_source from article:modified_time meta');
  if (article.published_at === article.updated_at_source) {
    throw new Error('expected published_at (Terbit 24 Jul 2026 11:00 WIB) and updated_at_source (14:12:07) to differ');
  }
  if (!Array.isArray(article.tags) || article.tags.length === 0) {
    throw new Error('expected tags from the fixture meta[name=news_keywords]');
  }
  const lowerTags = article.tags.map((t) => t.toLowerCase());
  if (lowerTags.includes('ekonomi') || lowerTags.includes('bisnis tirto') || lowerTags.includes('insider') || lowerTags.includes('flash news')) {
    throw new Error('expected channel/taxonomy labels (ekonomi/bisnis tirto/insider/flash news) to be filtered out of tags');
  }
  if (!lowerTags.includes('suku bunga acuan')) {
    throw new Error('expected a real topical keyword ("suku bunga acuan") to survive tag filtering');
  }
  if (article.category !== 'Ekonomi') {
    throw new Error(`expected category "Ekonomi" (last breadcrumb item), got ${article.category}`);
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[tirto smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawTirto.discoverLive({ limit: 5 });
    console.log(`[tirto smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[tirto smoke] OK');
}

main().catch((err) => {
  console.error('[tirto smoke] FAILED:', err);
  process.exitCode = 1;
});
