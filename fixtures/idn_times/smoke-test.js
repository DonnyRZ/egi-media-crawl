#!/usr/bin/env node
'use strict';

// Offline smoke test for the IDN Times adapter (Sprint 6a, S6a-A).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S6a-D owns that).
//
// Usage: node fixtures/idn_times/smoke-test.js
//   CRAWL_LIVE=true node fixtures/idn_times/smoke-test.js   # also exercises live discover()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'idn_times', 'coreAdapter'));
const rawIdnTimes = require(path.join('..', '..', 'src', 'adapters', 'idn_times'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[idn_times smoke] source profile:', JSON.stringify(profile, null, 2));

  if (profile.source_id !== 'idn_times') throw new Error('expected source_id "idn_times"');
  if (profile.adapter_version !== 'idn_times_v1') throw new Error('expected adapter_version "idn_times_v1"');
  if (!Array.isArray(profile.allowed_domains) || !profile.allowed_domains.includes('www.idntimes.com')) {
    throw new Error('expected allowed_domains to include "www.idntimes.com"');
  }

  console.log('\n[idn_times smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'idn_times', sourceProfile: profile, limit: 8 });
  console.log(`[idn_times smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}  published_hint: ${item.published_hint}`);
  }
  if (discoveryItems.length < 3) {
    throw new Error(`expected at least 3 discovered items from the fixture listing, got ${discoveryItems.length}`);
  }
  if (discoveryItems.some((item) => item.url.includes('bali.idntimes.com'))) {
    throw new Error('expected the non-article "Regional" hyperlocal promo widget to be excluded from discovery');
  }
  if (!discoveryItems.every((item) => item.external_id && /^[a-z0-9]{5}-[a-z0-9]{6}$/i.test(item.external_id))) {
    throw new Error('expected every discovered item to carry an "{authorCode5}-{articleCode6}" external_id');
  }

  console.log('\n[idn_times smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    [discoveryItems[0].url, true],
    ['https://www.idntimes.com/news', false],
    ['https://www.idntimes.com/news/indonesia', false],
    ['https://www.idntimes.com/author/contoh-jurnalis-fixture-fxtur', false],
    ['https://www.idntimes.com/tag/contoh-topik-fixture', false],
    ['https://www.idntimes.com/search?q=contoh', false],
    ['https://bali.idntimes.com/contoh-artikel-hyperlocal-00-abcde-fghijk', false],
    ['https://www.idntimes.com/news/indonesia/contoh-judul-berita-idn-times-pertama-00-fxtur-a1b2c3', true],
  ];
  for (const [url, expected] of isArticleChecks) {
    const actual = coreAdapter.isArticleUrl(url);
    console.log(`  - ${actual}  <- ${url}`);
    if (actual !== expected) {
      throw new Error(`isArticleUrl("${url}") expected ${expected}, got ${actual}`);
    }
  }

  console.log('\n[idn_times smoke] --- parse() (fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0] && discoveryItems[0].url });
  console.log(`[idn_times smoke] title: ${article.title}`);
  console.log(`[idn_times smoke] summary: ${article.summary}`);
  console.log(`[idn_times smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[idn_times smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[idn_times smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[idn_times smoke] published_at: ${article.published_at}`);
  console.log(`[idn_times smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[idn_times smoke] author_name: ${article.author_name}`);
  console.log(`[idn_times smoke] category: ${article.category}`);
  console.log(`[idn_times smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[idn_times smoke] language: ${article.language}`);
  console.log(`[idn_times smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[idn_times smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture');
  if (article.title !== 'Contoh Judul Berita IDN Times Pertama') throw new Error(`unexpected title: ${article.title}`);
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (!article.content_text.includes('Paragraf kedua')) {
    throw new Error('expected the second DOM paragraph to survive extraction');
  }
  if (!article.summary) throw new Error('expected summary from fixture NewsArticle.description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture NewsArticle.image.url');
  if (!article.published_at) throw new Error('expected published_at from fixture NewsArticle.datePublished');
  if (!article.updated_at_source) throw new Error('expected updated_at_source from fixture NewsArticle.dateModified');
  if (article.published_at === article.updated_at_source) {
    throw new Error('expected published_at (11:00 WIB) and updated_at_source (16:03:52 WIB) to differ in the fixture');
  }
  if (article.author_name !== 'Contoh Jurnalis Fixture') throw new Error(`unexpected author_name: ${article.author_name}`);
  if (article.category !== 'Indonesia') throw new Error(`expected category "Indonesia" (last breadcrumb item), got ${article.category}`);
  if (!Array.isArray(article.tags) || article.tags.length === 0) {
    throw new Error('expected tags from the fixture NewsArticle.keywords');
  }
  const lowerTags = article.tags.map((t) => t.toLowerCase());
  if (lowerTags.includes('update me')) {
    throw new Error('expected the junk "Update me" keyword to be filtered out of tags');
  }
  if (!lowerTags.includes('contoh topik fixture')) {
    throw new Error('expected a real topical keyword ("Contoh Topik Fixture") to survive tag filtering');
  }
  if (article.external_article_id !== 'fxtur-a1b2c3') {
    throw new Error(`expected external_article_id "fxtur-a1b2c3", got ${article.external_article_id}`);
  }
  if (article.language !== 'id') throw new Error('expected language "id"');
  if (article.parser_version !== 'idn_times_v1') throw new Error('expected parser_version "idn_times_v1"');
  if (!article.field_provenance || !article.field_provenance.published_at) {
    throw new Error('expected field_provenance to be populated');
  }

  console.log('\n[idn_times smoke] --- articleBody fallback (no DOM paragraphs) ---');
  const fallbackHtml = `<!DOCTYPE html><html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Contoh Tanpa DOM","articleBody":"Ini contoh isi artikel tanpa struktur paragraf DOM sama sekali.","datePublished":"2026-07-24T09:00:00+07:00","dateModified":"2026-07-24T09:00:00+07:00","author":[{"name":"Contoh Jurnalis Fixture"}]}</script>
  </head><body></body></html>`;
  const fallbackArticle = await coreAdapter.parse(fallbackHtml, { url: 'https://www.idntimes.com/news/indonesia/contoh-tanpa-dom-00-fxtur-z9y8x7' });
  console.log(`[idn_times smoke] fallback content_text: ${fallbackArticle.content_text}`);
  if (!fallbackArticle.content_text.includes('Ini contoh isi artikel tanpa struktur paragraf DOM')) {
    throw new Error('expected articleBody fallback to populate content_text when DOM paragraphs are absent');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[idn_times smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawIdnTimes.discoverLive({ limit: 5 });
    console.log(`[idn_times smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[idn_times smoke] OK');
}

main().catch((err) => {
  console.error('[idn_times smoke] FAILED:', err);
  process.exitCode = 1;
});
