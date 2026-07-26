#!/usr/bin/env node
'use strict';

// Offline smoke test for the Kumparan adapter (Sprint 4, S4-B).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S4-D owns that).
//
// Usage: node fixtures/kumparan/smoke-test.js
//   CRAWL_LIVE=true node fixtures/kumparan/smoke-test.js   # also exercises live discoverLive()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'kumparan', 'coreAdapter'));
const rawKumparan = require(path.join('..', '..', 'src', 'adapters', 'kumparan'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[kumparan smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[kumparan smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'kumparan', sourceProfile: profile, limit: 8 });
  console.log(`[kumparan smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}`);
    console.log(`      published_hint: ${item.published_hint}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the fixture GraphQL feed');
  }
  if (discoveryItems.every((item) => item.channel !== 'fixture')) {
    throw new Error('expected discover() to label fixture-sourced items with channel "fixture"');
  }

  console.log('\n[kumparan smoke] --- honoring ctx.limit ---');
  const limited = await coreAdapter.discover({ sourceId: 'kumparan', sourceProfile: profile, limit: 2 });
  console.log(`[kumparan smoke] limit=2 -> discovered ${limited.length} item(s)`);
  if (limited.length !== 2) {
    throw new Error(`expected exactly 2 items when ctx.limit = 2, got ${limited.length}`);
  }

  console.log('\n[kumparan smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://kumparan.com/channel/news',
    'https://kumparan.com/channel/bisnis',
    'https://kumparan.com/topic/rano-karno',
    'https://kumparan.com/kumparannews',
    'https://kumparan.com/kumparannews/contoh-tanpa-shortid-valid',
    'https://www.detik.com/kumparannews/out-of-scope-host-24AbC1dEfGh',
  ];
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://kumparan.com/channel/news')) {
    throw new Error('expected a /channel/{slug} URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://kumparan.com/topic/rano-karno')) {
    throw new Error('expected a /topic/{slug} URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://kumparan.com/kumparannews')) {
    throw new Error('expected a bare single-segment account profile URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://kumparan.com/kumparannews/contoh-tanpa-shortid-valid')) {
    throw new Error('expected a slug with no valid 11-char shortId suffix to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.detik.com/kumparannews/out-of-scope-host-24AbC1dEfGh')) {
    throw new Error('expected an out-of-scope host to be excluded even with a valid-looking path');
  }

  console.log('\n[kumparan smoke] --- parse() (fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0].url });
  console.log(`[kumparan smoke] title: ${article.title}`);
  console.log(`[kumparan smoke] summary: ${article.summary}`);
  console.log(`[kumparan smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[kumparan smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[kumparan smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[kumparan smoke] published_at: ${article.published_at}`);
  console.log(`[kumparan smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[kumparan smoke] author_name: ${article.author_name}`);
  console.log(`[kumparan smoke] category: ${article.category}`);
  console.log(`[kumparan smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[kumparan smoke] language: ${article.language}`);
  console.log(`[kumparan smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[kumparan smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (article.content_text.includes('Ilustrasi ruas tol baru yang diresmikan')) {
    throw new Error('expected figcaption noise to be stripped from content_text (not selected as a story-paragraph)');
  }
  if (!article.summary) throw new Error('expected summary from fixture meta[name=description]');
  if (article.summary.includes('#newsupdate')) {
    throw new Error('expected trailing hashtags to never leak into summary');
  }
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture JSON-LD image[0]');
  if (!article.published_at) throw new Error('expected published_at from JSON-LD datePublished');
  if (!article.updated_at_source) throw new Error('expected updated_at_source from JSON-LD dateModified');
  if (article.published_at === article.updated_at_source) {
    throw new Error('expected published_at and updated_at_source to differ (fixture sets a real post-publish edit)');
  }
  if (article.author_name !== 'Ahmad Fixture Saputra') {
    throw new Error(`expected the real JSON-LD byline "Ahmad Fixture Saputra", got ${article.author_name}`);
  }
  if (article.category !== 'News') {
    throw new Error(`expected category "News" (breadcrumb channel item), got ${article.category}`);
  }
  if (!Array.isArray(article.tags) || article.tags.length === 0) {
    throw new Error('expected tags from the fixture footer tag-topic links');
  }
  const lowerTags = article.tags.map((t) => t.toLowerCase());
  if (!lowerTags.includes('jalan tol') || !lowerTags.includes('infrastruktur')) {
    throw new Error('expected real topic tags ("Jalan Tol", "Infrastruktur") from the footer, not the keyword-stuffed meta list');
  }
  if (lowerTags.some((t) => t.startsWith('berita terkini') || t.startsWith('berita terbaru'))) {
    throw new Error('expected SEO keyword-stuffing ("Berita Terkini ...") to never leak into tags when the footer list is present');
  }
  if (article.external_article_id !== '24AbC1dEfGh') {
    throw new Error(`expected external_article_id "24AbC1dEfGh", got ${article.external_article_id}`);
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[kumparan smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawKumparan.discoverLive({ limit: 5 });
    console.log(`[kumparan smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[kumparan smoke] OK');
}

main().catch((err) => {
  console.error('[kumparan smoke] FAILED:', err);
  process.exitCode = 1;
});
