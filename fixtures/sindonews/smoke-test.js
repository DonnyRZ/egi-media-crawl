#!/usr/bin/env node
'use strict';

// Offline smoke test for the SINDOnews adapter (Sprint 5, S5-B).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S5-D owns that).
//
// Usage: node fixtures/sindonews/smoke-test.js
//   CRAWL_LIVE=true node fixtures/sindonews/smoke-test.js   # also exercises live discover()/parse()

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'sindonews', 'coreAdapter'));
const rawSindonews = require(path.join('..', '..', 'src', 'adapters', 'sindonews'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[sindonews smoke] source profile:', JSON.stringify(profile, null, 2));

  assert(profile.source_id === 'sindonews', 'expected source_id "sindonews"');
  assert(profile.adapter_version === 'sindonews_v1', 'expected adapter_version "sindonews_v1"');
  assert(
    Array.isArray(profile.allowed_domains) && profile.allowed_domains.includes('www.sindonews.com'),
    'expected allowed_domains to include www.sindonews.com'
  );
  for (const kanal of Object.keys(rawSindonews.KANAL_HOSTS)) {
    assert(
      profile.allowed_domains.includes(`${kanal}.sindonews.com`),
      `expected allowed_domains to include ${kanal}.sindonews.com`
    );
  }
  assert(
    !profile.allowed_domains.some((host) => host === 'e.sindonews.com' || host === 'pict.sindonews.com'),
    'expected allowed_domains to EXCLUDE asset/CDN hosts e.sindonews.com / pict.sindonews.com'
  );

  console.log('\n[sindonews smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'sindonews', sourceProfile: profile, limit: 8 });
  console.log(`[sindonews smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(
      `      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}  published_hint: ${item.published_hint}`
    );
  }
  assert(discoveryItems.length > 0, 'expected at least one discovered item from the fixture listing');

  const discoveredHosts = new Set(discoveryItems.map((item) => new URL(item.url).hostname));
  console.log(`[sindonews smoke] discovered hosts: ${[...discoveredHosts].join(', ')}`);
  assert(discoveredHosts.size >= 2, 'expected discover() to surface at least 2 distinct kanal subdomains from the fixture listing');

  console.log('\n[sindonews smoke] --- isArticleUrl() checks (multi-subdomain scope) ---');
  const trueChecks = [
    'https://ekbis.sindonews.com/read/1731775/178/ihsg-sesi-siang-terjun-bebas-175-ke-6204-transaksi-tembus-rp104-triliun-1784873276',
    'https://international.sindonews.com/read/1731809/43/as-rugi-besar-akibat-serangan-iran-di-seluruh-negara-arab-1784876878',
    'https://nasional.sindonews.com/read/1731777/14/kecanggihan-12-pesawat-latih-tempur-leonardo-m-346-f-block-20-yang-dibeli-kemhan-1784873270',
    // pagination path-segment variant ("/5" is a page offset, NOT a second id — still in scope)
    'https://ekbis.sindonews.com/read/1731775/178/ihsg-sesi-siang-terjun-bebas-175-ke-6204-transaksi-tembus-rp104-triliun-1784873276/5',
    // showpage=all query variant — still in scope
    'https://ekbis.sindonews.com/read/1731775/178/ihsg-sesi-siang-terjun-bebas-175-ke-6204-transaksi-tembus-rp104-triliun-1784873276?showpage=all',
  ];
  const falseChecks = [
    // asset/CDN hosts (task brief: EXCLUDE explicitly)
    'https://e.sindonews.com/mobile/2016/images/snicon/sindonews-logo-notag-220.png',
    'https://pict.sindonews.com/dyn/850/pena/news/2026/07/24/178/1731775/ihsg-sesi-siang-terjun-bebas-bbb.jpg',
    // out-of-scope MNC-group products (different template family, not a news kanal)
    'https://hi-lite.sindonews.com/read/1731900/1/contoh-hi-lite-1784900000',
    'https://scope.sindonews.com/',
    'https://media.sindonews.com/tv/rcti',
    // discovery-entry-point alias, never an article host itself
    'https://index.sindonews.com/indeks',
    // sibling MNC-group brand and unrelated news brands — must never be mistaken for in-scope
    'https://www.okezone.com/read/1731775/178/contoh-artikel-okezone-1784873276',
    'https://www.detik.com/berita/d-1234567/contoh-judul-berita-detik',
    // listing/index/tag/blog pages on in-scope hosts — not article shapes
    'https://www.sindonews.com/indeks',
    'https://www.sindonews.com/indeks/0/20?t=2026-07-24',
    'https://www.sindonews.com/topic/3440/ihsg',
    'https://www.sindonews.com/blog/2425/tangguh-yudha-ramadhan',
  ];

  for (const url of trueChecks) {
    const result = coreAdapter.isArticleUrl(url);
    console.log(`  - ${result}  <- ${url}`);
    assert(result === true, `expected isArticleUrl(true) for in-scope URL: ${url}`);
  }
  for (const url of falseChecks) {
    const result = coreAdapter.isArticleUrl(url);
    console.log(`  - ${result}  <- ${url}`);
    assert(result === false, `expected isArticleUrl(false) for out-of-scope URL: ${url}`);
  }

  console.log('\n[sindonews smoke] --- external_id dedupe key (same /read/{id}/, different kanal subdomains) ---');
  const urlA = 'https://ekbis.sindonews.com/read/1731775/178/ihsg-sesi-siang-terjun-bebas-175-ke-6204-transaksi-tembus-rp104-triliun-1784873276';
  const urlB = 'https://international.sindonews.com/read/1731775/999/republished-under-a-different-kanal-hypothetically-1784873276';
  const externalIdA = rawSindonews.extractExternalId(urlA);
  const externalIdB = rawSindonews.extractExternalId(urlB);
  console.log(`  - external_id(${urlA}) = ${externalIdA}`);
  console.log(`  - external_id(${urlB}) = ${externalIdB}`);
  assert(externalIdA === '1731775' && externalIdA === externalIdB, 'expected the same numeric /read/{id}/ to yield the same external_id across kanal subdomains');

  // Also verify the pagination path-segment trap (task brief: "/5, /10 ... are page offsets,
  // not IDs") never leaks into external_id.
  const pagedUrl = `${urlA}/5`;
  assert(rawSindonews.extractExternalId(pagedUrl) === '1731775', 'expected external_id to ignore the pagination path segment');

  console.log('\n[sindonews smoke] --- parse() (fixture page 1 + auto-merged showpage=all fixture) ---');
  const article = await coreAdapter.parse(undefined, { url: discoveryItems[0] && discoveryItems[0].url });
  console.log(`[sindonews smoke] title: ${article.title}`);
  console.log(`[sindonews smoke] summary: ${article.summary}`);
  console.log(`[sindonews smoke] thumbnail_url: ${article.thumbnail_url}`);
  console.log(`[sindonews smoke] canonical_url: ${article.canonical_url}`);
  console.log(`[sindonews smoke] external_article_id: ${article.external_article_id}`);
  console.log(`[sindonews smoke] published_at: ${article.published_at}`);
  console.log(`[sindonews smoke] updated_at_source: ${article.updated_at_source}`);
  console.log(`[sindonews smoke] author_name: ${article.author_name}`);
  console.log(`[sindonews smoke] category: ${article.category}`);
  console.log(`[sindonews smoke] tags: ${JSON.stringify(article.tags)}`);
  console.log(`[sindonews smoke] language: ${article.language}`);
  console.log(`[sindonews smoke] content_text length: ${article.content_text.length} chars`);
  console.log(`[sindonews smoke] field_provenance.content_text: ${JSON.stringify(article.field_provenance.content_text)}`);
  console.log(`\n[sindonews smoke] content_text preview:\n${article.content_text}`);

  assert(Boolean(article.title), 'expected title from fixture');
  assert(article.canonical_url === 'https://ekbis.sindonews.com/read/1900005/178/contoh-artikel-ekbis-sindonews-multipage-1900000005', 'expected canonical_url to be the bare page-1 URL (no pagination suffix, no showpage=all query)');
  assert(article.external_article_id === '1900005', 'expected external_article_id parsed from the canonical URL');
  assert(Boolean(article.content_text), 'expected content_text from fixture');
  assert(!article.content_text.includes('Baca Juga'), 'expected "Baca Juga" recirculation prompts to be stripped from content_text');
  assert(!article.content_text.includes('editor'), 'expected the trailing .editor desk sign-off div to be stripped');
  assert(!/youtube|iframe/i.test(article.content_text), 'expected the embedded .v-youtube video widget to be stripped');
  assert(article.content_text.includes('Paragraf keempat ini hanya muncul pada varian showpage=all'), 'expected the showpage=all-only paragraph to be present, proving the multipage merge actually ran');
  assert(article.field_provenance.content_text.used_showpage_all === true, 'expected field_provenance to record that showpage=all was used');
  assert(article.summary && article.summary.includes('Ekbis'), 'expected summary from fixture JSON-LD description');
  assert(Boolean(article.thumbnail_url), 'expected thumbnail_url from fixture JSON-LD image');
  assert(article.published_at === '2026-07-24T07:00:00.000Z', 'expected published_at parsed from JSON-LD datePublished (14:00 WIB = 07:00 UTC)');
  assert(Boolean(article.updated_at_source), 'expected updated_at_source from JSON-LD dateModified');
  assert(article.category === 'bursa finansial', 'expected category from the BreadcrumbList JSON-LD last item');
  assert(Array.isArray(article.tags) && article.tags.includes('sindonews fixture'), 'expected tags from fixture meta[name=keywords]');
  assert(article.language === 'id', 'expected hardcoded language "id"');

  console.log('\n[sindonews smoke] --- parse() single-page-only fallback (showpage=all fetch unavailable) ---');
  const singlePageDraft = await rawSindonews.parse(undefined, {
    url: discoveryItems[0] && discoveryItems[0].url,
    fetchShowpageAll: async () => undefined, // force "no extra fetch available" to prove single-page fallback still works
  });
  console.log(`[sindonews smoke] single-page-only usedShowpageAll: ${singlePageDraft.usedShowpageAll} (expected false)`);
  console.log(`[sindonews smoke] single-page-only paragraph count: ${singlePageDraft.paragraphs.length}`);
  assert(singlePageDraft.usedShowpageAll === false, 'expected usedShowpageAll=false when the extra fetch is unavailable');
  assert(!singlePageDraft.paragraphs.join(' ').includes('showpage=all, mewakili'), 'expected the showpage=all-only paragraph to be ABSENT in the single-page fallback');
  assert(Boolean(singlePageDraft.title), 'expected metadata (title) to still be present in the single-page fallback');

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[sindonews smoke] --- discoverLive() (CRAWL_LIVE=true) ---');
    const live = await rawSindonews.discoverLive({ limit: 5 });
    console.log(`[sindonews smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - ${item.rawUrl}`);
    }
  }

  console.log('\n[sindonews smoke] OK');
}

main().catch((err) => {
  console.error('[sindonews smoke] FAILED:', err);
  process.exitCode = 1;
});
