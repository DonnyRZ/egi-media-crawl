#!/usr/bin/env node
'use strict';

// Offline smoke test for the VIVA adapter (Pilot P3).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT
// going through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn`
// injection — so this never depends on `src/workers/lib/fetchHtml.js` having a
// fixture-path entry for "viva" (it intentionally doesn't; see `src/adapters/viva/
// index.js` header comment on why both discover() and multipage merge default to
// fixture-only unless CRAWL_LIVE=true is set).
//
// Usage: node fixtures/viva/smoke-test.js

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'viva', 'coreAdapter'));
const rawViva = require(path.join('..', '..', 'src', 'adapters', 'viva'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[viva smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[viva smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'viva', sourceProfile: profile });
  console.log(`[viva smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}`);
    console.log(`      external_id: ${item.external_id}  category_hint: ${item.category_hint}`);
  }

  const isArticleChecks = [
    discoveryItems[0] && discoveryItems[0].url,
    'https://www.viva.co.id/indeks',
    'https://www.viva.co.id/tag/pemilu-2029',
    'https://sport.viva.co.id/1234561-out-of-scope-subdomain',
  ].filter(Boolean);
  console.log('\n[viva smoke] --- isArticleUrl() checks ---');
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }

  console.log('\n[viva smoke] --- parse() (fixture page 1 + auto-merged fixture page 2) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0] && discoveryItems[0].url });
  console.log(`[viva smoke] title: ${article.title}`);
  console.log(`[viva smoke] summary: ${article.summary}`);
  console.log(`[viva smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[viva smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[viva smoke] published_at: ${article.published_at}`);
  console.log(`[viva smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[viva smoke] author_name: ${article.author_name}`);
  console.log(`[viva smoke] category: ${article.category}`);
  console.log(`[viva smoke] language: ${article.language}`);
  console.log(`[viva smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`[viva smoke] field_provenance.content_text: ${JSON.stringify(article.field_provenance.content_text)}`);
  console.log(`\n[viva smoke] content_text preview:\n${article.content_text}`);

  if (!article.summary) {
    throw new Error('expected summary from fixture JSON-LD/og:description');
  }
  if (!article.thumbnail_url) {
    throw new Error('expected thumbnail_url from fixture');
  }

  const singlePageDraft = await rawViva.parse(undefined, {
    url: discoveryItems[0] && discoveryItems[0].url,
    fetchPage: async () => undefined, // force "no extra page available" to prove single-page fallback still works
  });
  console.log(`\n[viva smoke] single-page-only fallback pagesMerged: ${singlePageDraft.pagesMerged} (expected 1)`);
  console.log(`[viva smoke] raw draft summary present: ${Boolean(singlePageDraft.summary)}`);

  console.log('\n[viva smoke] OK');
}

main().catch((err) => {
  console.error('[viva smoke] FAILED:', err);
  process.exitCode = 1;
});
