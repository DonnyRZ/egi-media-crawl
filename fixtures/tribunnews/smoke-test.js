#!/usr/bin/env node
'use strict';

// Offline smoke test for the Tribunnews adapter (Sprint 6b, S6b-C).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S6b-D owns that).
//
// Usage: node fixtures/tribunnews/smoke-test.js
//   CRAWL_LIVE=true node fixtures/tribunnews/smoke-test.js   # also exercises live discover()
//     (uses index.js's own LIVE_UA, a genuine browser-class UA — see that file's module header
//     on why the shared CRAWLER_UA convention is deliberately NOT reused for this source)

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'tribunnews', 'coreAdapter'));
const rawTribunnews = require(path.join('..', '..', 'src', 'adapters', 'tribunnews'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[tribunnews smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[tribunnews smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'tribunnews', sourceProfile: profile, limit: 8 });
  console.log(`[tribunnews smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}  published_hint: ${item.published_hint}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the fixtures');
  }
  if (discoveryItems.length > 8) {
    throw new Error(`expected discover() to honor ctx.limit=8, got ${discoveryItems.length}`);
  }
  const channels = new Set(discoveryItems.map((item) => item.channel));
  const hasIndexNewsChannel = [...channels].some((c) => c.startsWith('index_news'));
  const hasSitemapNewsChannel = [...channels].some((c) => c.startsWith('sitemap_news'));
  if (!hasIndexNewsChannel) {
    throw new Error('expected at least one item from the primary index_news channel');
  }
  if (!hasSitemapNewsChannel) {
    throw new Error('expected at least one item from the secondary sitemap_news channel');
  }
  // fixtures/tribunnews/sitemap-news.xml deliberately repeats index-news.html's first URL to
  // exercise cross-channel dedup (see module header note on why the secondary channel is
  // sitemap-news.xml, not RSS).
  const urls = discoveryItems.map((item) => item.url);
  if (new Set(urls).size !== urls.length) {
    throw new Error('expected discover() to dedup the URL shared by both fixture channels');
  }

  console.log('\n[tribunnews smoke] --- honoring ctx.limit=3 ---');
  const limited = await coreAdapter.discover({ sourceId: 'tribunnews', sourceProfile: profile, limit: 3 });
  console.log(`[tribunnews smoke] limited discover() returned ${limited.length} item(s)`);
  if (limited.length !== 3) {
    throw new Error(`expected exactly 3 items when ctx.limit=3, got ${limited.length}`);
  }

  console.log('\n[tribunnews smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    ['https://www.tribunnews.com/nasional/9000101/contoh-judul-berita-nasional-pertama-untuk-fixture-offline', true],
    ['https://www.tribunnews.com/internasional/2026/07/24/contoh-artikel-internasional-format-tanggal-untuk-fixture', true],
    ['https://www.tribunnews.com/index-news', false],
    ['https://www.tribunnews.com/index-news/nasional', false],
    ['https://www.tribunnews.com/internasional', false],
    ['https://www.tribunnews.com/internasional?page=2', false],
    ['https://www.tribunnews.com/tag/contoh-tag', false],
    ['https://www.tribunnews.com/topic/contoh-topik', false],
    ['https://www.tribunnews.com/search?q=contoh', false],
    ['https://www.tribunnews.com/penulis/contoh-reporter', false],
    ['https://www.tribunnews.com/editor/contoh-editor', false],
    ['https://m.tribunnews.com/nasional/9000101/contoh-judul-berita-nasional-pertama-untuk-fixture-offline', false],
    ['https://tribunjabar.id/nasional/9000101/contoh-artikel-domain-lain', false],
    ['https://www.tribunnews.com/api/contoh', false],
  ];
  for (const [url, expected] of isArticleChecks) {
    const actual = coreAdapter.isArticleUrl(url);
    console.log(`  - ${actual}  <- ${url}`);
    if (actual !== expected) {
      throw new Error(`isArticleUrl("${url}") expected ${expected}, got ${actual}`);
    }
  }

  console.log('\n[tribunnews smoke] --- parse() (fixture, normal 2-page article) ---');
  const article = await coreAdapter.parse(undefined, {
    url: 'https://www.tribunnews.com/internasional/9000301/contoh-judul-artikel-utama-untuk-fixture-offline-sprint-6b',
  });
  console.log(`[tribunnews smoke] title: ${article.title}`);
  console.log(`[tribunnews smoke] summary: ${article.summary}`);
  console.log(`[tribunnews smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[tribunnews smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[tribunnews smoke] published_at: ${article.published_at}`);
  console.log(`[tribunnews smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[tribunnews smoke] author_name: ${article.author_name}`);
  console.log(`[tribunnews smoke] category: ${article.category}`);
  console.log(`[tribunnews smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[tribunnews smoke] language: ${article.language}`);
  console.log(`[tribunnews smoke] adapter_version/parser_version: ${coreAdapter.ADAPTER_VERSION} / ${article.parser_version}`);
  console.log(`[tribunnews smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`[tribunnews smoke] content_text field_provenance: ${JSON.stringify(article.field_provenance.content_text)}`);
  console.log(`\n[tribunnews smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture jsonld:headline');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture link[rel=canonical]');
  if (!article.content_text) throw new Error('expected content_text from fixture div.side-article.txt-article');
  if (article.content_text.includes('Ringkasan Berita')) {
    throw new Error('expected the "Ringkasan Berita" summary-recap blockquote to be stripped from content_text');
  }
  if (article.content_text.includes('Baca juga')) {
    throw new Error('expected "Baca juga" noise to be stripped from content_text');
  }
  if (article.content_text.includes('Ilustrasi contoh')) {
    throw new Error('expected figure/figcaption noise to be stripped from content_text');
  }
  if (article.content_text.includes('iklan-placeholder')) {
    throw new Error('expected .ads-placeholder noise to be stripped from content_text');
  }
  if (article.content_text.includes('widget rekomendasi')) {
    throw new Error('expected the sibling .side-article.mb5 recommendation widget to be excluded (compound selector must not match it)');
  }
  if (!article.content_text.includes('Contoh Subjudul di Tengah Artikel')) {
    throw new Error('expected the in-body <h2> subheading to be kept in content_text');
  }
  if (!article.content_text.includes('halaman kedua')) {
    throw new Error('expected page-2 paragraphs to be merged into content_text (multipage support)');
  }
  if (article.field_provenance.content_text.pages_merged !== 2) {
    throw new Error(`expected pages_merged=2 for the 2-page fixture, got ${article.field_provenance.content_text.pages_merged}`);
  }
  if (article.field_provenance.content_text.confidence !== 'high') {
    throw new Error('expected the normal (isAccessibleForFree=true) fixture article to have HIGH content_text confidence');
  }
  if (!article.summary) throw new Error('expected summary from fixture jsonld:description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture jsonld:image.url');
  if (article.external_article_id !== '9000301') {
    throw new Error(`expected external_article_id "9000301" (URL numeric id segment), got ${article.external_article_id}`);
  }
  if (!article.published_at) throw new Error('expected published_at from fixture jsonld:datePublished');
  if (!article.updated_at_source) throw new Error('expected updated_at_source from fixture jsonld:dateModified');
  if (article.category !== 'Internasional') {
    throw new Error(`expected category "Internasional" (jsonld:articleSection), got ${article.category}`);
  }
  if (!Array.isArray(article.tags) || article.tags.length !== 3) {
    throw new Error(`expected 3 tags from fixture jsonld:keywords, got ${JSON.stringify(article.tags)}`);
  }
  if (article.language !== 'id') throw new Error('expected language "id"');

  console.log('\n[tribunnews smoke] --- parse() (fixture, single-page-only fallback via ctx.fetchPage) ---');
  const singlePageDraft = await rawTribunnews.parse(undefined, {
    url: 'https://www.tribunnews.com/internasional/9000301/contoh-judul-artikel-utama-untuk-fixture-offline-sprint-6b',
    fetchPage: async () => undefined, // force "no extra page available" to prove single-page fallback still works
  });
  console.log(`[tribunnews smoke] single-page-only fallback pagesMerged: ${singlePageDraft.pagesMerged} (expected 1)`);
  if (singlePageDraft.pagesMerged !== 1) {
    throw new Error(`expected pagesMerged=1 when ctx.fetchPage returns undefined, got ${singlePageDraft.pagesMerged}`);
  }

  console.log('\n[tribunnews smoke] --- parse() (fixture, premium/isAccessibleForFree=false article) ---');
  const premiumArticle = await coreAdapter.parse(undefined, {
    url: 'https://www.tribunnews.com/premium/9000302/contoh-judul-artikel-premium-untuk-fixture-offline-sprint-6b',
    fixtureVariant: 'premium',
  });
  console.log(`[tribunnews smoke] premium title: ${premiumArticle.title}`);
  console.log(`[tribunnews smoke] premium content_text length: ${premiumArticle.content_text.length} chars`);
  console.log(`[tribunnews smoke] premium content_text field_provenance: ${JSON.stringify(premiumArticle.field_provenance.content_text)}`);

  if (!premiumArticle.title) throw new Error('expected title from the premium fixture');
  if (!premiumArticle.content_text) {
    throw new Error('expected a short (non-empty) teaser content_text from the premium fixture — never faked/padded');
  }
  if (premiumArticle.field_provenance.content_text.confidence !== 'low') {
    throw new Error('expected the isAccessibleForFree=false fixture article to have LOW content_text confidence');
  }
  if (!premiumArticle.field_provenance.content_text.note) {
    throw new Error('expected an explanatory field_provenance note for the isAccessibleForFree=false article');
  }

  console.log('\n[tribunnews smoke] --- parse() (fixture, date-pattern URL shape, DOM-derived external_article_id) ---');
  const dateArticle = await coreAdapter.parse(undefined, {
    url: 'https://www.tribunnews.com/internasional/2026/07/24/contoh-artikel-internasional-format-tanggal-untuk-fixture',
    fixtureVariant: 'datepattern',
  });
  console.log(`[tribunnews smoke] datepattern title: ${dateArticle.title}`);
  console.log(`[tribunnews smoke] datepattern external_article_id: ${dateArticle.external_article_id}`);
  if (dateArticle.external_article_id !== '9000303') {
    throw new Error(`expected external_article_id "9000303" (DOM data-content-id/meta android:app_id fallback), got ${dateArticle.external_article_id}`);
  }
  if (!coreAdapter.isArticleUrl('https://www.tribunnews.com/internasional/2026/07/24/contoh-artikel-internasional-format-tanggal-untuk-fixture')) {
    throw new Error('expected the date-pattern URL shape to be recognized as an article URL');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[tribunnews smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawTribunnews.discoverLive({ limit: 5 });
    console.log(`[tribunnews smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[tribunnews smoke] OK');
}

main().catch((err) => {
  console.error('[tribunnews smoke] FAILED:', err);
  process.exitCode = 1;
});
