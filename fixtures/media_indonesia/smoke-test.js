#!/usr/bin/env node
'use strict';

// Offline smoke test for the Media Indonesia adapter (Sprint 6a, S6a-C).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S6a-D owns that).
//
// Usage: node fixtures/media_indonesia/smoke-test.js
//   CRAWL_LIVE=true node fixtures/media_indonesia/smoke-test.js   # also exercises live discover()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'media_indonesia', 'coreAdapter'));
const rawMediaIndonesia = require(path.join('..', '..', 'src', 'adapters', 'media_indonesia'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[media_indonesia smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[media_indonesia smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'media_indonesia', sourceProfile: profile, limit: 8 });
  console.log(`[media_indonesia smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the fixture listing');
  }
  if (discoveryItems.length > 8) {
    throw new Error(`expected discover() to honor ctx.limit=8, got ${discoveryItems.length}`);
  }
  const channels = new Set(discoveryItems.map((item) => item.channel));
  const hasIndeksChannel = [...channels].some((c) => c.startsWith('indeks_html'));
  const hasSitemapChannel = [...channels].some((c) => c.startsWith('sitemap_news'));
  if (!hasIndeksChannel) {
    throw new Error('expected at least one item from the primary indeks_html channel');
  }
  if (!hasSitemapChannel) {
    throw new Error('expected at least one item from the secondary sitemap_news channel');
  }

  console.log('\n[media_indonesia smoke] --- honoring ctx.limit=2 ---');
  const limited = await coreAdapter.discover({ sourceId: 'media_indonesia', sourceProfile: profile, limit: 2 });
  console.log(`[media_indonesia smoke] limited discover() returned ${limited.length} item(s)`);
  if (limited.length !== 2) {
    throw new Error(`expected exactly 2 items when ctx.limit=2, got ${limited.length}`);
  }

  console.log('\n[media_indonesia smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://mediaindonesia.com/indeks',
    'https://mediaindonesia.com/indeks/20/40',
    'https://mediaindonesia.com/ekonomi',
    'https://mediaindonesia.com/ekonomi/20/40',
    'https://mediaindonesia.com/video/detail_video/2955-yamal-belum-kelasnya-messi-ojo-dibanding-bandingke',
    'https://mediaindonesia.com/galleries/detail_galleries/49614-denpasar-tattoo-fest-dorong-industri-tato',
    'https://mediaindonesia.com/tag/contoh-tag',
    'https://www.mediaindonesia.com/jelita/913303/gerakan-anti-ruam-perluas-edukasi-ke-450-posyandu-dan-180-puskesmas',
    'https://tirto.id/some-other-site-article-hzAA',
  ];
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://mediaindonesia.com/indeks/20/40')) {
    throw new Error('expected the /indeks/20/40 offset-pagination URL to be excluded from isArticleUrl()');
  }
  if (coreAdapter.isArticleUrl('https://mediaindonesia.com/ekonomi/20/40')) {
    throw new Error('expected the /ekonomi/20/40 category-pagination URL to be excluded from isArticleUrl()');
  }
  if (coreAdapter.isArticleUrl('https://mediaindonesia.com/video/detail_video/2955-yamal-belum-kelasnya-messi-ojo-dibanding-bandingke')) {
    throw new Error('expected a /video/detail_video/... URL to be excluded (out-of-scope content type)');
  }
  if (coreAdapter.isArticleUrl('https://mediaindonesia.com/galleries/detail_galleries/49614-denpasar-tattoo-fest-dorong-industri-tato')) {
    throw new Error('expected a /galleries/detail_galleries/... URL to be excluded (out-of-scope content type)');
  }
  if (!coreAdapter.isArticleUrl('https://www.mediaindonesia.com/jelita/913303/gerakan-anti-ruam-perluas-edukasi-ke-450-posyandu-dan-180-puskesmas')) {
    throw new Error('expected the www.mediaindonesia.com alias host to still be recognized as in-scope');
  }
  if (coreAdapter.isArticleUrl('https://tirto.id/some-other-site-article-hzAA')) {
    throw new Error('expected an out-of-scope domain to be excluded');
  }

  console.log('\n[media_indonesia smoke] --- parse() (fixture, normal article) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0].url });
  console.log(`[media_indonesia smoke] title: ${article.title}`);
  console.log(`[media_indonesia smoke] summary: ${article.summary}`);
  console.log(`[media_indonesia smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[media_indonesia smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[media_indonesia smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[media_indonesia smoke] published_at: ${article.published_at}`);
  console.log(`[media_indonesia smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[media_indonesia smoke] author_name: ${article.author_name}`);
  console.log(`[media_indonesia smoke] category: ${article.category}`);
  console.log(`[media_indonesia smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[media_indonesia smoke] language: ${article.language}`);
  console.log(`[media_indonesia smoke] adapter_version/parser_version: ${coreAdapter.ADAPTER_VERSION} / ${article.parser_version}`);
  console.log(`[media_indonesia smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`[media_indonesia smoke] content_text field_provenance: ${JSON.stringify(article.field_provenance.content_text)}`);
  console.log(`\n[media_indonesia smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture og:title');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture link[rel=canonical]');
  if (!article.content_text) throw new Error('expected content_text from fixture div.article');
  if (article.content_text.includes('Baca juga')) {
    throw new Error('expected "Baca juga" noise to be stripped from content_text');
  }
  if (article.content_text.toLowerCase().includes('cek berita dan artikel')) {
    throw new Error('expected the trailing Google News/WhatsApp follow-CTA to be stripped from content_text');
  }
  if (!article.content_text.includes('(H-2)')) {
    throw new Error('expected the trailing journalist sign-off code "(H-2)" to be kept as real editorial content');
  }
  if (!article.content_text.includes('Contoh Subjudul di Tengah Artikel')) {
    throw new Error('expected the in-body <h2> subheading to be kept in content_text');
  }
  if (article.field_provenance.content_text.confidence !== 'high') {
    throw new Error('expected the normal fixture article to have HIGH content_text confidence (not premium/teaser)');
  }
  if (!article.summary) throw new Error('expected summary from fixture meta[name=description]');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture og:image');
  if (article.external_article_id !== '900001') {
    throw new Error(`expected external_article_id "900001" (URL numeric id segment), got ${article.external_article_id}`);
  }
  if (!article.published_at) throw new Error('expected published_at from fixture article:published_time meta');
  if (!article.updated_at_source) throw new Error('expected updated_at_source from fixture article:modified_time meta');
  if (!Array.isArray(article.tags) || article.tags.length !== 3) {
    throw new Error('expected 3 tags from the fixture tag-pill widget, with leading "#" stripped');
  }
  if (article.tags.some((t) => t.startsWith('#'))) {
    throw new Error('expected the leading "#" marker to be stripped from every tag');
  }
  if (article.category !== 'Jelita') {
    throw new Error(`expected category "Jelita" (last breadcrumb item), got ${article.category}`);
  }
  if (article.language !== 'id') throw new Error('expected language "id"');

  console.log('\n[media_indonesia smoke] --- parse() (fixture, premium/teaser article) ---');
  const premiumArticle = await coreAdapter.parse(undefined, {
    url: 'https://mediaindonesia.com/ekonomi/900009/contoh-judul-berita-premium-media-indonesia',
    fixtureVariant: 'premium',
  });
  console.log(`[media_indonesia smoke] premium title: ${premiumArticle.title}`);
  console.log(`[media_indonesia smoke] premium content_text length: ${premiumArticle.content_text.length} chars`);
  console.log(`[media_indonesia smoke] premium content_text field_provenance: ${JSON.stringify(premiumArticle.field_provenance.content_text)}`);

  if (!premiumArticle.title) throw new Error('expected title from the premium fixture');
  if (!premiumArticle.content_text) {
    throw new Error('expected a short (non-empty) teaser content_text from the premium fixture — never faked/padded');
  }
  if (premiumArticle.field_provenance.content_text.confidence !== 'low') {
    throw new Error('expected the premium/teaser fixture article to have LOW content_text confidence');
  }
  if (!premiumArticle.field_provenance.content_text.note) {
    throw new Error('expected an explanatory field_provenance note for the premium/teaser article');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[media_indonesia smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawMediaIndonesia.discoverLive({ limit: 5 });
    console.log(`[media_indonesia smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[media_indonesia smoke] OK');
}

main().catch((err) => {
  console.error('[media_indonesia smoke] FAILED:', err);
  process.exitCode = 1;
});
