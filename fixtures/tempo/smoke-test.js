#!/usr/bin/env node
'use strict';

// Offline smoke test for the Tempo.co adapter (Sprint 4, S4-A).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S4-D owns that).
//
// Usage: node fixtures/tempo/smoke-test.js
//   CRAWL_LIVE=true node fixtures/tempo/smoke-test.js   # also exercises live discoverLive()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'tempo', 'coreAdapter'));
const rawTempo = require(path.join('..', '..', 'src', 'adapters', 'tempo'));

// Minimal inline HTML covering the Tempo Plus ("VIP") case — `isAccessibleForFree: false`,
// truncated `articleBody`/DOM body (verified live shape, see index.js module header) — kept
// inline here rather than as a second full fixture file, since the ONLY thing under test is
// the paywall-confidence-downgrade behavior in coreAdapter.js's `buildFieldProvenance()`.
const VIP_ARTICLE_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
  <link rel="canonical" href="https://www.tempo.co/politik/contoh-analisis-tempo-plus-9100003">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Contoh Analisis Tempo Plus Soal Arah Kebijakan Moneter","description":"Contoh analisis mendalam berlabel Tempo Plus.","image":"https://statik.tempo.co/data/2026/07/24/id_9100003/9100003_720.jpg","datePublished":"2026-07-24T07:30:00+07:00","isAccessibleForFree":false,"articleBody":"CONTOH pembuka artikel yang hanya menampilkan satu paragraf teaser sebelum dikunci Tempo Plus.","author":[{"@type":"Person","name":"Contoh Reporter Dua"}]}</script>
</head>
<body>
  <h1>Contoh Analisis Tempo Plus Soal Arah Kebijakan Moneter</h1>
  <div id="content-wrapper"><p>CONTOH pembuka artikel yang hanya menampilkan satu paragraf teaser sebelum dikunci Tempo Plus.</p></div>
</body>
</html>`;

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[tempo smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[tempo smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'tempo', sourceProfile: profile, limit: 8 });
  console.log(`[tempo smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(
      `      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}  published_hint: ${item.published_hint}  accessHint: ${item.metadata && item.metadata.accessHint}`
    );
  }
  if (discoveryItems.length !== 3) {
    throw new Error(`expected exactly 3 discovered items from the fixture rubric payload, got ${discoveryItems.length}`);
  }
  if (!discoveryItems.every((item) => coreAdapter.isArticleUrl(item.url))) {
    throw new Error('expected every discovered URL to be recognized as an article URL');
  }
  if (!discoveryItems.some((item) => item.metadata && item.metadata.accessHint === 'VIP')) {
    throw new Error('expected at least one discovered item to carry accessHint "VIP" (the fixture includes a Tempo Plus item)');
  }
  if (!discoveryItems[0].published_hint) {
    throw new Error('expected published_hint to be parsed (no-tz "YYYY-MM-DD HH:MM:SS" treated as WIB) from the fixture payload');
  }

  console.log('\n[tempo smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://www.tempo.co/ekonomi',
    'https://www.tempo.co/ekonomi/bisnis',
    'https://www.tempo.co/ekonomi/sinyal-pasar',
    'https://www.tempo.co/politik/pendidikan',
    'https://www.tempo.co/penulis/aditya-budiman-998',
    'https://www.tempo.co/tag/tarif-impor',
    'https://www.tempo.co/tag/piala-dunia-2026',
    'https://www.tempo.co/ekonomi/trump-umumkan-tarif-impor-baru-ke-60-negara-2277913',
    'https://tempo.co/ekonomi/trump-umumkan-tarif-impor-baru-ke-60-negara-2277913',
    'https://foo.tempo.co/ekonomi/trump-umumkan-tarif-impor-baru-ke-60-negara-2277913',
    'https://www.detik.com/ekonomi/contoh-artikel-lain-2277913',
  ];
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://www.tempo.co/ekonomi')) {
    throw new Error('expected a bare rubrik-root URL (/ekonomi) to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.tempo.co/ekonomi/bisnis')) {
    throw new Error('expected a sub-rubrik listing URL (/ekonomi/bisnis) to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.tempo.co/penulis/aditya-budiman-998')) {
    throw new Error('expected an author-profile URL (/penulis/...-998) to be excluded despite ending in digits');
  }
  if (coreAdapter.isArticleUrl('https://www.tempo.co/tag/piala-dunia-2026')) {
    throw new Error('expected a /tag/ URL to be excluded even when the alias itself ends in digits');
  }
  if (!coreAdapter.isArticleUrl('https://tempo.co/ekonomi/trump-umumkan-tarif-impor-baru-ke-60-negara-2277913')) {
    throw new Error('expected the bare tempo.co host (no www) to still be recognized as in-scope');
  }
  if (coreAdapter.isArticleUrl('https://foo.tempo.co/ekonomi/trump-umumkan-tarif-impor-baru-ke-60-negara-2277913')) {
    throw new Error('expected an out-of-scope subdomain (foo.tempo.co) to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.detik.com/ekonomi/contoh-artikel-lain-2277913')) {
    throw new Error('expected an out-of-scope host (detik.com) to be excluded');
  }

  console.log('\n[tempo smoke] --- parse() (fixture, free article) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0].url });
  console.log(`[tempo smoke] title: ${article.title}`);
  console.log(`[tempo smoke] summary: ${article.summary}`);
  console.log(`[tempo smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[tempo smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[tempo smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[tempo smoke] published_at: ${article.published_at}`);
  console.log(`[tempo smoke] author_name: ${article.author_name}`);
  console.log(`[tempo smoke] category: ${article.category}`);
  console.log(`[tempo smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[tempo smoke] language: ${article.language}`);
  console.log(`[tempo smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`[tempo smoke] field_provenance.content_text: ${JSON.stringify(article.field_provenance.content_text)}`);
  console.log(`\n[tempo smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (article.content_text.includes('Pilihan Editor')) {
    throw new Error('expected trailing "Pilihan Editor: ..." related-article pick to be stripped from content_text');
  }
  if (article.content_text.includes('Scroll ke bawah')) {
    throw new Error('expected the lazy-load-gate paragraph (outside #content-wrapper) to never be picked up');
  }
  if (!article.summary) throw new Error('expected summary from fixture jsonld:description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture jsonld:image');
  if (!article.published_at) throw new Error('expected published_at parsed from JSON-LD datePublished');
  if (article.external_article_id !== '9100001') {
    throw new Error(`expected external_article_id "9100001" (trailing numeric id), got ${article.external_article_id}`);
  }
  if (article.category !== 'Bisnis') {
    throw new Error(`expected category "Bisnis" (last non-"Home" breadcrumb item), got ${article.category}`);
  }
  if (!Array.isArray(article.tags) || article.tags.length !== 3) {
    throw new Error(`expected exactly 3 tags from the tag-pill widget (a[href^="/tag/"]), got ${JSON.stringify(article.tags)}`);
  }
  if (article.author_name !== 'Contoh Reporter') {
    throw new Error(`expected author_name "Contoh Reporter" (deduplicated from 2 identical JSON-LD Person entries), got ${article.author_name}`);
  }
  if (article.field_provenance.content_text.confidence !== 'high') {
    throw new Error('expected content_text confidence "high" for a free (isAccessibleForFree=true) article');
  }

  console.log('\n[tempo smoke] --- parse() (inline HTML, Tempo Plus / paywalled article) ---');
  const vipArticle = await coreAdapter.parse(VIP_ARTICLE_HTML, { url: 'https://www.tempo.co/politik/contoh-analisis-tempo-plus-9100003' });
  console.log(`[tempo smoke] vip content_text: ${vipArticle.content_text}`);
  console.log(`[tempo smoke] vip field_provenance.content_text: ${JSON.stringify(vipArticle.field_provenance.content_text)}`);
  if (vipArticle.field_provenance.content_text.confidence !== 'low') {
    throw new Error('expected content_text confidence to drop to "low" when jsonld:isAccessibleForFree is false');
  }
  if (!vipArticle.content_text.includes('teaser')) {
    throw new Error('expected the VIP article to still honestly surface its short teaser content_text (not fail/empty)');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[tempo smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawTempo.discoverLive({ limit: 5 });
    console.log(`[tempo smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[tempo smoke] OK');
}

main().catch((err) => {
  console.error('[tempo smoke] FAILED:', err);
  process.exitCode = 1;
});
