#!/usr/bin/env node
'use strict';

// Offline smoke test for the Merdeka.com adapter (Sprint 6b, S6b-A).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S6b-D owns that).
//
// Usage: node fixtures/merdeka/smoke-test.js
//   CRAWL_LIVE=true node fixtures/merdeka/smoke-test.js   # also exercises live discover()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'merdeka', 'coreAdapter'));
const rawMerdeka = require(path.join('..', '..', 'src', 'adapters', 'merdeka'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[merdeka smoke] source profile:', JSON.stringify(profile, null, 2));

  if (profile.source_id !== 'merdeka') throw new Error('expected source_id "merdeka"');
  if (profile.adapter_version !== 'merdeka_v1') throw new Error('expected adapter_version "merdeka_v1"');
  if (!Array.isArray(profile.allowed_domains) || !profile.allowed_domains.includes('www.merdeka.com')) {
    throw new Error('expected allowed_domains to include "www.merdeka.com"');
  }

  console.log('\n[merdeka smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'merdeka', sourceProfile: profile, limit: 8 });
  console.log(`[merdeka smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}  published_hint: ${item.published_hint}`);
  }
  if (discoveryItems.length < 5) {
    throw new Error(`expected at least 5 discovered items (hub + sitemap merged), got ${discoveryItems.length}`);
  }
  if (!discoveryItems.some((item) => item.channel.startsWith('category_hub:'))) {
    throw new Error('expected at least one item from the category_hub channel');
  }
  if (!discoveryItems.some((item) => item.channel.startsWith('sitemap:'))) {
    throw new Error('expected at least one item from the sitemap channel (secondary discovery)');
  }
  if (discoveryItems.some((item) => item.url.includes('?page='))) {
    throw new Error('expected robots-disallowed "?page=" pagination URLs to never be discovered');
  }
  const urls = discoveryItems.map((item) => item.url);
  if (new Set(urls).size !== urls.length) {
    throw new Error('expected discovered items to be de-duplicated across the hub + sitemap channels');
  }
  if (!discoveryItems.every((item) => item.external_id && /^\d+$/.test(item.external_id))) {
    throw new Error('expected every discovered item to carry a bare numeric external_id');
  }
  const sitemapItem = discoveryItems.find((item) => item.channel.startsWith('sitemap:'));
  if (!sitemapItem.published_hint) {
    throw new Error('expected the sitemap channel to supply a published_hint (unlike the hub channel, see index.js doc)');
  }

  console.log('\n[merdeka smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    [discoveryItems[0].url, true],
    ['https://www.merdeka.com/peristiwa', false],
    ['https://www.merdeka.com/peristiwa/regional', false],
    ['https://www.merdeka.com/peristiwa?page=2', false],
    ['https://www.merdeka.com/author/contoh_wartawan_fixture', false],
    ['https://www.merdeka.com/tag/contoh-fixture', false],
    ['https://www.merdeka.com/search?q=contoh', false],
    ['https://www.merdeka.com/foto/read/8253682/contoh-galeri-foto-fixture', false],
    ['https://www.merdeka.com/video/read/8253682/contoh-video-fixture', false],
    ['https://www.merdeka.com/peristiwa/read/8253998/contoh-judul-artikel-merdeka-pertama', true],
  ];
  for (const [url, expected] of isArticleChecks) {
    const actual = coreAdapter.isArticleUrl(url);
    console.log(`  - ${actual}  <- ${url}`);
    if (actual !== expected) {
      throw new Error(`isArticleUrl("${url}") expected ${expected}, got ${actual}`);
    }
  }

  console.log('\n[merdeka smoke] --- parse() (fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: 'https://www.merdeka.com/peristiwa/read/8253998/contoh-judul-artikel-merdeka-pertama' });
  console.log(`[merdeka smoke] title: ${article.title}`);
  console.log(`[merdeka smoke] summary: ${article.summary}`);
  console.log(`[merdeka smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[merdeka smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[merdeka smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[merdeka smoke] published_at: ${article.published_at}`);
  console.log(`[merdeka smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[merdeka smoke] author_name: ${article.author_name}`);
  console.log(`[merdeka smoke] category: ${article.category}`);
  console.log(`[merdeka smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[merdeka smoke] language: ${article.language}`);
  console.log(`[merdeka smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[merdeka smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture');
  if (article.title !== 'Contoh Judul Artikel Merdeka Pertama') throw new Error(`unexpected title: ${article.title}`);
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (!article.content_text.includes('halaman pertama')) {
    throw new Error('expected page-1 paragraph to survive extraction');
  }
  if (!article.content_text.includes('halaman kedua')) {
    throw new Error('expected page-2 paragraph to ALSO survive extraction — multipage content is pre-merged into one fetch (see index.js doc), no extra network I/O needed');
  }
  if (article.content_text.includes('Advertisement')) {
    throw new Error('expected the nested ad-slot "Advertisement" <p> to be excluded by the direct-child .articles-content__body > p selector');
  }
  if (article.content_text.includes('Baca Juga') || article.content_text.includes('Contoh Berita Fixture Kedua')) {
    throw new Error('expected the "Baca Juga" related-link box to be excluded (it has no direct-child <p> of its own)');
  }
  if (!article.summary) throw new Error('expected summary from fixture meta[name=description]');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture NewsArticle.image[0]');
  if (!article.published_at) throw new Error('expected published_at from fixture article:published_time meta');
  if (!article.updated_at_source) throw new Error('expected updated_at_source from fixture article:modified_time meta');
  if (article.published_at === article.updated_at_source) {
    throw new Error('expected published_at (16:58 WIB) and updated_at_source (18:30 WIB) to differ in the fixture');
  }
  if (article.author_name !== 'Contoh Wartawan Fixture') {
    throw new Error(`expected author_name "Contoh Wartawan Fixture" (from meta[name=author], NOT the null JSON-LD author), got ${article.author_name}`);
  }
  if (article.category !== 'Regional') {
    throw new Error(`expected category "Regional" (breadcrumb DOM last item, NOT the useless BreadcrumbList JSON-LD), got ${article.category}`);
  }
  if (!Array.isArray(article.tags) || article.tags.length === 0) {
    throw new Error('expected tags from the fixture .tags-articles__list');
  }
  const lowerTags = article.tags.map((t) => t.toLowerCase());
  if (!lowerTags.includes('contoh topik fixture')) {
    throw new Error('expected a real tag ("contoh topik fixture") to survive extraction');
  }
  if (article.external_article_id !== '8253998') {
    throw new Error(`expected external_article_id "8253998", got ${article.external_article_id}`);
  }
  if (article.language !== 'id') throw new Error('expected language "id"');
  if (article.parser_version !== 'merdeka_v1') throw new Error('expected parser_version "merdeka_v1"');
  if (!article.field_provenance || !article.field_provenance.published_at) {
    throw new Error('expected field_provenance to be populated');
  }

  console.log('\n[merdeka smoke] --- extractKlyState() fallback checks ---');
  const kly = rawMerdeka.extractKlyState(require('fs').readFileSync(rawMerdeka.FIXTURE_ARTICLE_PATH, 'utf8'));
  if (!kly || !kly.category || kly.category.name !== 'Regional') {
    throw new Error('expected window.kly.category.name "Regional" to be parseable from the fixture as a fallback source');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[merdeka smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawMerdeka.discoverLive({ limit: 5 });
    console.log(`[merdeka smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - [${item.discoveryChannel}] ${item.rawUrl}`);
    }
  }

  console.log('\n[merdeka smoke] OK');
}

main().catch((err) => {
  console.error('[merdeka smoke] FAILED:', err);
  process.exitCode = 1;
});
