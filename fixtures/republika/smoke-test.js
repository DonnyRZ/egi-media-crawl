#!/usr/bin/env node
'use strict';

// Offline smoke test for the Republika Online adapter (Sprint 6a, S6a-B).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S6a-D owns that).
//
// Usage: node fixtures/republika/smoke-test.js
//   CRAWL_LIVE=true node fixtures/republika/smoke-test.js   # also exercises live discover()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'republika', 'coreAdapter'));
const rawRepublika = require(path.join('..', '..', 'src', 'adapters', 'republika'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[republika smoke] source profile:', JSON.stringify(profile, null, 2));

  console.log('\n[republika smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'republika', sourceProfile: profile, limit: 8 });
  console.log(`[republika smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(`      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}`);
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the fixture listing');
  }
  if (discoveryItems.length < 3) {
    throw new Error('expected the bundled indeks.html fixture to yield 3 discovered item(s)');
  }

  console.log('\n[republika smoke] --- isArticleUrl() checks ---');
  const isArticleChecks = [
    discoveryItems[0].url,
    'https://www.republika.co.id/indeks',
    'https://republika.co.id/index/ekonomi/0',
    'https://republika.co.id/kanal/news',
    'https://static.republika.co.id/uploads/images/foo.jpg',
    'https://republika.co.id/berita//tio14w368/contoh-slug-malformed-double-slash',
    'https://rejabar.republika.co.id/berita/tioaiy487/contoh-artikel-regional',
    'https://www.detik.com/berita/d-1234567/bukan-republika',
  ];
  for (const url of isArticleChecks) {
    console.log(`  - ${coreAdapter.isArticleUrl(url)}  <- ${url}`);
  }
  if (!coreAdapter.isArticleUrl(discoveryItems[0].url)) {
    throw new Error('expected the first discovered URL to be recognized as an article URL');
  }
  if (coreAdapter.isArticleUrl('https://www.republika.co.id/indeks')) {
    throw new Error('expected the /indeks listing URL itself to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://republika.co.id/kanal/news')) {
    throw new Error('expected a /kanal/ navigation URL to be excluded');
  }
  if (coreAdapter.isArticleUrl('https://static.republika.co.id/uploads/images/foo.jpg')) {
    throw new Error('expected the static.republika.co.id asset host to be excluded');
  }
  if (!coreAdapter.isArticleUrl('https://republika.co.id/berita//tio14w368/contoh-slug-malformed-double-slash')) {
    throw new Error('expected the live-verified malformed double-slash /berita// URL shape to still be recognized');
  }
  if (!coreAdapter.isArticleUrl('https://rejabar.republika.co.id/berita/tioaiy487/contoh-artikel-regional')) {
    throw new Error('expected a regional (rejabar) subdomain article URL to be recognized (multi-subdomain, one source_id)');
  }
  if (coreAdapter.isArticleUrl('https://www.detik.com/berita/d-1234567/bukan-republika')) {
    throw new Error('expected an out-of-scope non-republika.co.id host to be excluded');
  }

  console.log('\n[republika smoke] --- parse() (fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0].url });
  console.log(`[republika smoke] title: ${article.title}`);
  console.log(`[republika smoke] summary: ${article.summary}`);
  console.log(`[republika smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[republika smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[republika smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[republika smoke] published_at: ${article.published_at}`);
  console.log(`[republika smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[republika smoke] author_name: ${article.author_name}`);
  console.log(`[republika smoke] category: ${article.category}`);
  console.log(`[republika smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[republika smoke] language: ${article.language}`);
  console.log(`[republika smoke] adapter_version (parser_version): ${article.parser_version}`);
  console.log(`[republika smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`\n[republika smoke] content_text preview:\n${article.content_text}`);

  if (!article.title) throw new Error('expected title from fixture');
  if (!article.canonical_url) throw new Error('expected canonical_url from fixture');
  if (!article.content_text) throw new Error('expected content_text from fixture');
  if (article.content_text.includes('Baca Juga') || article.content_text.includes('Contoh Artikel Terkait')) {
    throw new Error('expected "Baca Juga" picked-article noise to be stripped from content_text');
  }
  if (article.content_text.includes('keterangan foto')) {
    throw new Error('expected figcaption noise to be stripped from content_text');
  }
  if (article.content_text.includes('Catatan kaki fixture')) {
    throw new Error('expected .footnote-wrap noise to be stripped from content_text');
  }
  if (!article.content_text.includes('paragraf pembuka')) {
    throw new Error('expected the real opening paragraph to survive extraction');
  }
  if (!article.summary) throw new Error('expected summary from fixture JSON-LD description');
  if (!article.thumbnail_url) throw new Error('expected thumbnail_url from fixture JSON-LD image.url');
  if (!article.published_at) throw new Error('expected published_at from JSON-LD datePublished');
  if (!article.updated_at_source) throw new Error('expected updated_at_source from JSON-LD dateModified');
  if (article.author_name !== 'Contoh Redaktur') {
    throw new Error(`expected author_name "Contoh Redaktur" (the JSON-LD "Red:" editor byline), got ${article.author_name}`);
  }
  if (article.category !== 'Energi') {
    throw new Error(`expected category "Energi" (last non-"Home" breadcrumb item), got ${article.category}`);
  }
  if (!Array.isArray(article.tags) || article.tags.length === 0) {
    throw new Error('expected tags from the fixture meta[name=keywords]');
  }
  if (article.parser_version !== 'republika_v1') {
    throw new Error(`expected parser_version "republika_v1", got ${article.parser_version}`);
  }

  console.log('\n[republika smoke] --- extractSitemapArticleUrls() / extractRssItems() (secondary discovery, unit-level) ---');
  const sitemapSample = `<?xml version="1.0"?><urlset>
    <url><loc>https://republika.co.id/kanal/news</loc></url>
    <url><loc>https://ekonomi.republika.co.id/berita/fixtur004/contoh-sitemap-artikel</loc></url>
  </urlset>`;
  const sitemapUrls = rawRepublika.extractSitemapArticleUrls(sitemapSample);
  console.log(`[republika smoke] sitemap /berita/ url(s): ${JSON.stringify(sitemapUrls)}`);
  if (sitemapUrls.length !== 1 || !sitemapUrls[0].includes('/berita/')) {
    throw new Error('expected extractSitemapArticleUrls() to keep only the /berita/ entry and drop the /kanal/ entry');
  }

  const rssSample = `<rss><channel>
    <item>
      <title>Contoh Judul RSS</title>
      <link>https://ekonomi.republika.co.id/berita/fixtur005/contoh-rss-artikel</link>
      <pubDate>Fri, 24 Jul 2026 16:32:58 +0700</pubDate>
      <category><![CDATA[Energi]]></category>
    </item>
  </channel></rss>`;
  const rssItems = rawRepublika.extractRssItems(rssSample);
  console.log(`[republika smoke] rss item(s): ${JSON.stringify(rssItems)}`);
  if (rssItems.length !== 1 || rssItems[0].categoryHint !== 'Energi') {
    throw new Error('expected extractRssItems() to parse exactly 1 item with categoryHint "Energi"');
  }

  console.log('\n[republika smoke] --- buildIndeksUrl() checks ---');
  console.log(`  offset only:      ${rawRepublika.buildIndeksUrl({ offset: 50 })}`);
  console.log(`  kanal + offset:   ${rawRepublika.buildIndeksUrl({ kanal: 'ekonomi', offset: 0 })}`);
  console.log(`  date-scoped:      ${rawRepublika.buildIndeksUrl({ offset: 0, date: { year: 2026, month: 7, day: 20 } })}`);
  if (rawRepublika.buildIndeksUrl({ offset: 50 }) !== 'https://republika.co.id/index/50') {
    throw new Error('expected buildIndeksUrl({ offset: 50 }) to build the all-kanal offset URL shape');
  }
  if (rawRepublika.buildIndeksUrl({ kanal: 'ekonomi', offset: 0 }) !== 'https://republika.co.id/index/ekonomi/0') {
    throw new Error('expected buildIndeksUrl({ kanal, offset }) to build the per-kanal URL shape');
  }

  console.log('\n[republika smoke] --- parseListingDate() checks ---');
  const absoluteDate = rawRepublika.parseListingDate('20 July 2026, 23:40');
  console.log(`  "20 July 2026, 23:40" -> ${absoluteDate}`);
  if (!absoluteDate) {
    throw new Error('expected parseListingDate() to parse the date-scoped listing\'s absolute English-month timestamp');
  }
  if (rawRepublika.parseListingDate('7 menit yang lalu') !== undefined) {
    throw new Error('expected parseListingDate() to return undefined for an unparseable relative Indonesian hint');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[republika smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawRepublika.discoverLive({ limit: 5 });
    console.log(`[republika smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[republika smoke] OK');
}

main().catch((err) => {
  console.error('[republika smoke] FAILED:', err);
  process.exitCode = 1;
});
