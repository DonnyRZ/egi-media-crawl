#!/usr/bin/env node
'use strict';

// Offline smoke test for the Jawa Pos adapter (Sprint 4, S4-C).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S4-D owns that).
//
// Usage: node fixtures/jawa_pos/smoke-test.js
//   CRAWL_LIVE=true node fixtures/jawa_pos/smoke-test.js   # also exercises live discover()
//     (limited to a handful of requests: HTML /indeks + a couple of GraphQL deep-pagination
//     pages — see index.js header for the exact endpoints hit).

const fs = require('fs');
const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'jawa_pos', 'coreAdapter'));
const rawJawaPos = require(path.join('..', '..', 'src', 'adapters', 'jawa_pos'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[jawa_pos smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[jawa_pos smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'jawa_pos', sourceProfile: profile, limit: 8 });
  console.log(`[jawa_pos smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}  published_hint: ${item.published_hint}`);
  }
  // With CRAWL_LIVE=true this same discover() call goes live (see index.js isLiveDiscoverEnabled)
  // and returns real /indeks items instead of the fixture's fixed 3 — only assert the exact
  // fixture count when running the deterministic, network-free path.
  if (process.env.CRAWL_LIVE !== 'true' && discoveryItems.length !== 3) {
    throw new Error(`expected exactly 3 discovered items from the bundled indeks.html fixture, got ${discoveryItems.length}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item');
  }
  if (!discoveryItems.every((item) => item.published_hint)) {
    throw new Error('expected every discovered item to carry a parsed published_hint (no-tz "YYYY-MM-DD HH:MM:SS" -> ISO +07:00)');
  }

  console.log('\n[jawa_pos smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://www.jawapos.com/indeks',
    'https://www.jawapos.com/nasional',
    'https://www.jawapos.com/sepak-bola-dunia',
    'https://www.jawapos.com/search',
    'https://www.jawapos.com/tag/contoh-tag',
    'https://www.jawapos.com/author/contoh-reporter',
    'https://jawapos.com/sepak-bola-dunia/2607240073/contoh-judul-berita-jawa-pos-pertama',
    'https://www.detik.com/nasional/2607240073/bukan-jawa-pos',
    'https://www.jawapos.com/sepak-bola-dunia/notadigitid/contoh-slug',
  ];
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://www.jawapos.com/indeks')) {
    throw new Error('expected /indeks to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.jawapos.com/nasional')) {
    throw new Error('expected a bare category-root URL (/nasional, no article_id/slug) to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.jawapos.com/tag/contoh-tag')) {
    throw new Error('expected a /tag/ URL to be excluded');
  }
  if (!coreAdapter.isArticleUrl('https://jawapos.com/sepak-bola-dunia/2607240073/contoh-judul-berita-jawa-pos-pertama')) {
    throw new Error('expected the bare jawapos.com alias host to still be recognized as in-scope');
  }
  if (coreAdapter.isArticleUrl('https://www.detik.com/nasional/2607240073/bukan-jawa-pos')) {
    throw new Error('expected an out-of-scope host (detik.com) to be excluded even with an otherwise-matching path shape');
  }
  if (coreAdapter.isArticleUrl('https://www.jawapos.com/sepak-bola-dunia/notadigitid/contoh-slug')) {
    throw new Error('expected a non-10-digit article_id segment to be excluded');
  }

  console.log('\n[jawa_pos smoke] --- parse() (fixture) ---');
  // Deliberately uses a fixed URL (not discoveryItems[0].url) so this section's exact-match
  // assertions stay deterministic even when CRAWL_LIVE=true swapped discover() to live data
  // above — parse() itself is always fixture-first when no `html` is supplied regardless.
  const fixtureArticleUrl = 'https://www.jawapos.com/sepak-bola-dunia/2607240073/contoh-judul-berita-jawa-pos-pertama';
  const article = await coreAdapter.parse(undefined, { url: fixtureArticleUrl });
  console.log(`[jawa_pos smoke] title: ${article.title}`);
  console.log(`[jawa_pos smoke] summary: ${article.summary}`);
  console.log(`[jawa_pos smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[jawa_pos smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[jawa_pos smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[jawa_pos smoke] published_at: ${article.published_at}`);
  console.log(`[jawa_pos smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[jawa_pos smoke] author_name: ${article.author_name}`);
  console.log(`[jawa_pos smoke] category: ${article.category}`);
  console.log(`[jawa_pos smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[jawa_pos smoke] language: ${article.language}`);
  console.log(`[jawa_pos smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[jawa_pos smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture __NEXT_DATA__');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (article.canonical_url !== 'https://www.jawapos.com/sepak-bola-dunia/2607240073/contoh-judul-berita-jawa-pos-pertama') {
    throw new Error(`unexpected canonical_url: ${article.canonical_url}`);
  }
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (article.content_text.includes('Contoh Artikel Terkait yang Tidak Boleh Ikut Terparsing')) {
    throw new Error('expected the "Baca Juga" related-link paragraph to be stripped from content_text');
  }
  if (article.content_text.includes('keterangan foto')) {
    throw new Error('expected figcaption noise to be excluded from content_text');
  }
  if (!article.content_text.includes('Contoh Subjudul di Tengah Artikel')) {
    throw new Error('expected the in-body <h2> subheading to be kept in content_text');
  }
  if (!article.content_text.includes('Paragraf kelima berada setelah marker pagination')) {
    throw new Error('expected the paragraph AFTER the <p class="page"> marker to survive (proves no content loss across the client-side reader-pagination marker)');
  }
  if (!article.summary) throw new Error('expected summary from fixture article.description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture article.cover');
  if (!article.published_at) throw new Error('expected published_at parsed from article.published_at (no-tz, assumed WIB)');
  if (article.updated_at_source !== undefined) {
    throw new Error('expected updated_at_source to be undefined (no such field exists for this source, see field matrix)');
  }
  if (article.author_name !== 'Contoh Reporter') {
    throw new Error(`expected author_name "Contoh Reporter", got ${article.author_name}`);
  }
  if (article.category !== 'Sepak Bola Dunia') {
    throw new Error(`expected category "Sepak Bola Dunia", got ${article.category}`);
  }
  if (!Array.isArray(article.tags) || article.tags.length !== 2) {
    throw new Error('expected exactly 2 tags from the fixture article.tags');
  }
  if (article.external_article_id !== '2607240073') {
    throw new Error(`expected external_article_id "2607240073", got ${article.external_article_id}`);
  }
  if (article.language !== 'id') {
    throw new Error(`expected language "id", got ${article.language}`);
  }
  if (article.parser_version !== 'jawa_pos_v1') {
    throw new Error(`expected parser_version "jawa_pos_v1", got ${article.parser_version}`);
  }

  console.log('\n[jawa_pos smoke] --- GraphQL deep-pagination fixture (offline shape check, no network) ---');
  const graphqlFixturePath = path.join(__dirname, 'graphql-articles-page2.json');
  const graphqlFixture = JSON.parse(fs.readFileSync(graphqlFixturePath, 'utf8'));
  const paginator = graphqlFixture.data.articles;
  console.log(`[jawa_pos smoke] graphql fixture hasMorePages: ${paginator.paginatorInfo.hasMorePages}, data length: ${paginator.data.length}`);
  if (!Array.isArray(paginator.data) || paginator.data.length === 0) {
    throw new Error('expected the bundled GraphQL fixture to document a non-empty ArticleSimplePaginator.data[]');
  }
  const graphqlEntries = paginator.data.map(rawJawaPos.toDiscoveryEntry).filter(Boolean);
  if (graphqlEntries.length !== paginator.data.length) {
    throw new Error('expected toDiscoveryEntry() to map every GraphQL fixture article into a discovery entry');
  }
  console.log(`[jawa_pos smoke] mapped ${graphqlEntries.length} discovery entr(y/ies) from the GraphQL fixture, e.g. ${graphqlEntries[0].rawUrl}`);

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[jawa_pos smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawJawaPos.discoverLive({ limit: 5 });
    console.log(`[jawa_pos smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[jawa_pos smoke] OK');
}

main().catch((err) => {
  console.error('[jawa_pos smoke] FAILED:', err);
  process.exitCode = 1;
});
