#!/usr/bin/env node
'use strict';

// Offline smoke test for the BeritaSatu adapter (Sprint 6b, S6b-B).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S6b-D owns that).
//
// Usage: node fixtures/beritasatu/smoke-test.js
//   CRAWL_LIVE=true node fixtures/beritasatu/smoke-test.js   # also exercises live discover(),
//   which uses LIVE_UA (the browser-class product UA — see index.js module header "CloudFront
//   WAF" note), never the bare EGIMediaCrawler/0.1-style UA every sibling adapter's
//   discoverLive() uses.

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'beritasatu', 'coreAdapter'));
const rawBeritasatu = require(path.join('..', '..', 'src', 'adapters', 'beritasatu'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[beritasatu smoke] source profile:', JSON.stringify(profile, null, 2));
  if (profile.source_id !== 'beritasatu') throw new Error('expected source_id "beritasatu"');
  if (profile.adapter_version !== 'beritasatu_v1') throw new Error('expected adapter_version "beritasatu_v1"');

  console.log('\n[beritasatu smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'beritasatu', sourceProfile: profile, limit: 8 });
  console.log(`[beritasatu smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the fixture listing');
  }
  if (discoveryItems.length !== 7) {
    throw new Error(`expected exactly 7 unique items after merging indeks(6) + sitemap(2, 1 dup), got ${discoveryItems.length}`);
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
  if (discoveryItems.some((item) => item.url.includes('900099'))) {
    throw new Error('expected the top-nav mega-menu preview card URL (900099) to never be discovered — it must not match the .row.gx-3.mt-4.position-relative listing-item selector');
  }
  if (discoveryItems.some((item) => item.url.includes('/tag/'))) {
    throw new Error('expected the /tag/ row fixture entry to be excluded from discovery (robots-disallowed, non-article)');
  }
  const sitemapOnlyUrl = discoveryItems.find((item) => item.url.includes('900007'));
  if (!sitemapOnlyUrl) {
    throw new Error('expected the sitemap-only article (900007) to be merged into the discovery results');
  }

  console.log('\n[beritasatu smoke] --- honoring ctx.limit=3 ---');
  const limited = await coreAdapter.discover({ sourceId: 'beritasatu', sourceProfile: profile, limit: 3 });
  console.log(`[beritasatu smoke] limited discover() returned ${limited.length} item(s)`);
  if (limited.length !== 3) {
    throw new Error(`expected exactly 3 items when ctx.limit=3, got ${limited.length}`);
  }

  console.log('\n[beritasatu smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://www.beritasatu.com/terkini/indeks',
    'https://www.beritasatu.com/nasional/indeks',
    'https://www.beritasatu.com/nasional/indeks/2',
    'https://www.beritasatu.com/tag/contoh-tag',
    'https://www.beritasatu.com/search/contoh',
    'https://www.beritasatu.com/widget/contoh',
    'https://www.beritasatu.com/widgets/contoh',
    'https://www.beritasatu.com/network/900001/contoh-network-tidak-termasuk',
    'https://www.beritasatu.com/penulis/contoh-reporter-satu',
    'https://www.beritasatu.com/editor/contoh-editor',
    'https://beritasatu.com/nasional/900001/contoh-berita-beritasatu-pertama',
    'https://www.beritasatu.com/bplus/3012880/contoh-artikel-bplus',
    'https://www.detik.com/berita/d-1234567/bukan-beritasatu',
  ];
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/terkini/indeks')) {
    throw new Error('expected the /terkini/indeks listing URL itself to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/nasional/indeks')) {
    throw new Error('expected a /{kanal}/indeks listing URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/nasional/indeks/2')) {
    throw new Error('expected a /{kanal}/indeks/{N} paginated listing URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/tag/contoh-tag')) {
    throw new Error('expected a robots-disallowed /tag/ URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/search/contoh')) {
    throw new Error('expected a robots-disallowed /search/ URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/widget/contoh')) {
    throw new Error('expected a robots-disallowed /widget/ URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/widgets/contoh')) {
    throw new Error('expected a robots-disallowed /widgets/ URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/network/900001/contoh-network-tidak-termasuk')) {
    throw new Error('expected a robots-disallowed /network/ URL to be excluded even if 3-segment-shaped');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/penulis/contoh-reporter-satu')) {
    throw new Error('expected a /penulis/{slug} author profile URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://www.beritasatu.com/editor/contoh-editor')) {
    throw new Error('expected a /editor/{slug} editor profile URL to be excluded');
  }
  if (!coreAdapter.isArticleUrl('https://beritasatu.com/nasional/900001/contoh-berita-beritasatu-pertama')) {
    throw new Error('expected the bare beritasatu.com host alias (no www.) to still be recognized as in-scope');
  }
  if (!coreAdapter.isArticleUrl('https://www.beritasatu.com/bplus/3012880/contoh-artikel-bplus')) {
    throw new Error('expected a /bplus/ (BeritaSatu Plus in-depth vertical) article URL to be recognized — open kanal set, no premium gate observed live');
  }
  if (coreAdapter.isArticleUrl('https://www.detik.com/berita/d-1234567/bukan-beritasatu')) {
    throw new Error('expected an out-of-scope non-beritasatu.com host to be excluded');
  }

  console.log('\n[beritasatu smoke] --- parse() (fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0].url });
  console.log(`[beritasatu smoke] title: ${article.title}`);
  console.log(`[beritasatu smoke] summary: ${article.summary}`);
  console.log(`[beritasatu smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[beritasatu smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[beritasatu smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[beritasatu smoke] published_at: ${article.published_at}`);
  console.log(`[beritasatu smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[beritasatu smoke] author_name: ${article.author_name}`);
  console.log(`[beritasatu smoke] category: ${article.category}`);
  console.log(`[beritasatu smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[beritasatu smoke] language: ${article.language}`);
  console.log(`[beritasatu smoke] adapter_version/parser_version: ${coreAdapter.ADAPTER_VERSION} / ${article.parser_version}`);
  console.log(`[beritasatu smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[beritasatu smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture JSON-LD headline');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture link[rel=canonical]');
  if (!article.content_text) throw new Error('expected content_text from fixture div.body-content');
  if (article.content_text.includes('BACA JUGA')) {
    throw new Error('expected the "BACA JUGA" label to be stripped from content_text');
  }
  if (article.content_text.includes('Contoh Artikel Terkait untuk Menguji Filter Baca Juga')) {
    throw new Error('expected the whole "BACA JUGA" wrapper div (incl. the linked related-article title) to be stripped, not just the label');
  }
  if (article.content_text.toLowerCase().includes('google news') || article.content_text.toLowerCase().includes('whatsapp channel')) {
    throw new Error('expected the Google News/WhatsApp Channel follow-CTA (outside div.body-content) to never appear in content_text');
  }
  if (article.content_text.includes('Contoh Tag Satu')) {
    throw new Error('expected the tag-pill widget (h3.badge, outside p/h2) to never appear in content_text');
  }
  if (!article.content_text.includes('paragraf pembuka')) {
    throw new Error('expected the real opening paragraph to survive extraction');
  }
  if (!article.content_text.includes('kutipan contoh dari narasumber fiktif')) {
    throw new Error('expected a mid-body quoted paragraph to survive extraction');
  }
  if (!article.summary) throw new Error('expected summary from fixture JSON-LD description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture JSON-LD image.url');
  if (article.external_article_id !== '900001') {
    throw new Error(`expected external_article_id "900001" (dataLayer.article_id), got ${article.external_article_id}`);
  }
  if (!article.published_at || !article.published_at.startsWith('2026-07-24')) {
    throw new Error(`expected published_at from fixture JSON-LD datePublished, got ${article.published_at}`);
  }
  if (!article.updated_at_source) throw new Error('expected updated_at_source from fixture JSON-LD dateModified');
  if (article.author_name !== 'Contoh Reporter Satu') {
    throw new Error(`expected author_name "Contoh Reporter Satu" (dataLayer.penulis), got ${article.author_name}`);
  }
  if (article.category !== 'Kesra') {
    throw new Error(`expected category "Kesra" (dataLayer.sub_category, more specific than content_category "Nasional"), got ${article.category}`);
  }
  if (!Array.isArray(article.tags) || article.tags.length !== 3) {
    throw new Error('expected 3 tags from the fixture dataLayer.tags CSV');
  }
  if (article.tags.some((t) => t.startsWith('#'))) {
    throw new Error('expected no leading "#" marker on any tag (dataLayer.tags has none, unlike Media Indonesia\'s DOM tag pills)');
  }
  if (article.language !== 'id') throw new Error('expected language "id"');
  if (article.parser_version !== 'beritasatu_v1') {
    throw new Error(`expected parser_version "beritasatu_v1", got ${article.parser_version}`);
  }
  if (article.field_provenance.content_text.confidence !== 'high') {
    throw new Error('expected content_text field_provenance confidence "high" (no premium/teaser gate observed live for BeritaSatu)');
  }

  console.log('\n[beritasatu smoke] --- extractDataLayer() / parseDataLayerTags() (unit-level) ---');
  const sampleDataLayerHtml = `<script>
    window.dataLayer.push({"content_category": "Sport", "sub_category": "Voli", "article_id": "123", "tags": "A,B, C"});
    window.gtag = function(){dataLayer.push(arguments);};
  </script>`;
  const dl = rawBeritasatu.extractDataLayer(sampleDataLayerHtml);
  console.log(`[beritasatu smoke] extractDataLayer(): ${JSON.stringify(dl)}`);
  if (dl.sub_category !== 'Voli' || dl.article_id !== '123') {
    throw new Error('expected extractDataLayer() to parse content_category/sub_category/article_id, ignoring the unrelated dataLayer.push(arguments) GTM call');
  }
  const parsedTags = rawBeritasatu.parseDataLayerTags(dl.tags);
  if (parsedTags.length !== 3 || parsedTags[2] !== 'C') {
    throw new Error(`expected parseDataLayerTags() to split+trim the CSV into 3 tags, got ${JSON.stringify(parsedTags)}`);
  }

  console.log('\n[beritasatu smoke] --- buildIndeksUrl() / buildSitemapNewsUrl() checks ---');
  console.log(`  page 1 (bare):       ${rawBeritasatu.buildIndeksUrl()}`);
  console.log(`  page 2 (path):       ${rawBeritasatu.buildIndeksUrl({ page: 2 })}`);
  console.log(`  kanal + page:        ${rawBeritasatu.buildIndeksUrl({ kanal: 'nasional', page: 3 })}`);
  console.log(`  sitemap (default):   ${rawBeritasatu.buildSitemapNewsUrl()}`);
  console.log(`  sitemap (kanal):     ${rawBeritasatu.buildSitemapNewsUrl('sport')}`);
  if (rawBeritasatu.buildIndeksUrl() !== 'https://www.beritasatu.com/terkini/indeks') {
    throw new Error('expected buildIndeksUrl() with no args to build the bare /terkini/indeks page-1 URL');
  }
  if (rawBeritasatu.buildIndeksUrl({ page: 2 }) !== 'https://www.beritasatu.com/terkini/indeks/2') {
    throw new Error('expected buildIndeksUrl({ page: 2 }) to build the path-pagination shape');
  }
  if (rawBeritasatu.buildIndeksUrl({ kanal: 'nasional', page: 3 }) !== 'https://www.beritasatu.com/nasional/indeks/3') {
    throw new Error('expected buildIndeksUrl({ kanal, page }) to build the per-kanal path shape');
  }
  if (rawBeritasatu.buildIndeksUrl().includes('?page=')) {
    throw new Error('expected buildIndeksUrl() to never generate a ?page= query string (path-based pagination only, per the task brief)');
  }
  if (rawBeritasatu.buildSitemapNewsUrl() !== 'https://www.beritasatu.com/sitemap/nasional/news.xml') {
    throw new Error('expected buildSitemapNewsUrl() with no args to default to the nasional kanal');
  }
  if (rawBeritasatu.buildSitemapNewsUrl('sport') !== 'https://www.beritasatu.com/sitemap/sport/news.xml') {
    throw new Error('expected buildSitemapNewsUrl(kanal) to build the per-kanal sitemap path');
  }

  console.log('\n[beritasatu smoke] --- parseIndonesianDateTime() checks ---');
  const parsedFallbackDate = rawBeritasatu.parseIndonesianDateTime('Jumat, 24 Juli 2026 | 16:39 WIB');
  console.log(`  "Jumat, 24 Juli 2026 | 16:39 WIB" -> ${parsedFallbackDate}`);
  if (!parsedFallbackDate || !parsedFallbackDate.startsWith('2026-07-24T09:39')) {
    throw new Error(`expected parseIndonesianDateTime() to parse the dataLayer.detail_published_date fallback format into UTC, got ${parsedFallbackDate}`);
  }
  if (rawBeritasatu.parseIndonesianDateTime('7 menit yang lalu') !== undefined) {
    throw new Error('expected parseIndonesianDateTime() to return undefined for an unparseable relative Indonesian hint');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[beritasatu smoke] --- discoverLive() (CRAWL_LIVE=true, uses LIVE_UA) ---');
    const live = await rawBeritasatu.discoverLive({ limit: 5 });
    console.log(`[beritasatu smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[beritasatu smoke] OK');
}

main().catch((err) => {
  console.error('[beritasatu smoke] FAILED:', err);
  process.exitCode = 1;
});
