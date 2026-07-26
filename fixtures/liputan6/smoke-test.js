#!/usr/bin/env node
'use strict';

// Offline smoke test for the Liputan6 adapter (Sprint 3, S3-B).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT
// going through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn`
// injection, and WITHOUT any network access (CRAWL_LIVE is left unset) — see
// `src/adapters/liputan6/index.js` header comment for why both discover() and parse()
// default to fixture-only/no-network unless CRAWL_LIVE=true is set.
//
// The main thing this proves: parse() merges paragraphs from BOTH `data-page` blocks in
// `fixtures/liputan6/sample-article.html` (a single-document multipage fixture) — NOT just
// page 1 — with zero extra HTTP fetches, since Liputan6 ships every page in one response.
//
// Usage: node fixtures/liputan6/smoke-test.js

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'liputan6', 'coreAdapter'));
const rawLiputan6 = require(path.join('..', '..', 'src', 'adapters', 'liputan6'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[liputan6 smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[liputan6 smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'liputan6', sourceProfile: profile, limit: 8 });
  console.log(`[liputan6 smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the fixture channel listing');
  }

  console.log('\n[liputan6 smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://www.liputan6.com/news/indeks',
    'https://www.liputan6.com/photo/read/9000004/contoh-galeri-foto-liputan6-bukan-artikel',
    'https://enamplus.liputan6.com/tv/read/8253582/pasutri-cabul-diamuk-massa',
  ].filter(Boolean);
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://www.liputan6.com/photo/read/9000004/contoh-galeri-foto-liputan6-bukan-artikel')) {
    throw new Error('expected /photo/read/ URLs to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://enamplus.liputan6.com/tv/read/8253582/pasutri-cabul-diamuk-massa')) {
    throw new Error('expected out-of-scope subdomains (enamplus.liputan6.com) to be excluded');
  }

  console.log('\n[liputan6 smoke] --- parse() (fixture, same-document multipage merge) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0].url });
  console.log(`[liputan6 smoke] title: ${article.title}`);
  console.log(`[liputan6 smoke] summary: ${article.summary}`);
  console.log(`[liputan6 smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[liputan6 smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[liputan6 smoke] published_at: ${article.published_at}`);
  console.log(`[liputan6 smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[liputan6 smoke] author_name: ${article.author_name}`);
  console.log(`[liputan6 smoke] category: ${article.category}`);
  console.log(`[liputan6 smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[liputan6 smoke] language: ${article.language}`);
  console.log(`[liputan6 smoke] field_provenance.content_text: ${JSON.stringify(article.field_provenance.content_text)}`);
  console.log(`\n[liputan6 smoke] content_text:\n${article.content_text}`);

  if (article.field_provenance.content_text.pages_merged !== 2) {
    throw new Error(
      `expected pages_merged === 2 (multipage fixture has data-page="1" and data-page="2"), got ${article.field_provenance.content_text.pages_merged}`
    );
  }
  if (!article.content_text.includes('Update Redaksi')) {
    throw new Error('expected page-2 sub-heading ("Update Redaksi") to be merged into content_text');
  }
  if (!article.content_text.includes('hanya ada di halaman kedua')) {
    throw new Error('expected page-2 paragraph text to be merged into content_text');
  }
  if (article.content_text.includes('BACA JUGA')) {
    throw new Error('expected "Baca Juga" noise block to be stripped from content_text');
  }
  if (!article.summary) {
    throw new Error('expected summary from fixture JSON-LD/og:description');
  }
  if (!article.thumbnail_url) {
    throw new Error('expected thumbnail_url from fixture');
  }
  if (!Array.isArray(article.tags) || article.tags.length === 0) {
    throw new Error('expected tags from fixture meta[name=keywords]');
  }

  const singlePageDraft = await rawLiputan6.parse(undefined, {});
  console.log(`\n[liputan6 smoke] raw draft pagesMerged: ${singlePageDraft.pagesMerged} (expected 2)`);
  if (singlePageDraft.pagesMerged !== 2) {
    throw new Error('expected raw parse() draft to report pagesMerged === 2');
  }

  console.log('\n[liputan6 smoke] OK');
}

main().catch((err) => {
  console.error('[liputan6 smoke] FAILED:', err);
  process.exitCode = 1;
});
