#!/usr/bin/env node
'use strict';

// Offline smoke test for the Okezone adapter (Sprint 5, S5-A).
//
// Exercises `discover()` and `parse()` directly against the bundled fixtures, WITHOUT going
// through the shared crawl pipeline (src/core/pipeline.js) or its `fetchFn` injection, and
// WITHOUT touching `src/adapters/index.js` (not registered yet — S5-D owns that).
//
// The main things this proves (see task brief "Smoke must assert"):
//   1. isArticleUrl() is true for >=2 DIFFERENT kanal subdomains (news.okezone.com,
//      bola.okezone.com), proving multi-subdomain scope.
//   2. isArticleUrl() is false for a sibling MNC Media brand (inews.id), an asset host
//      (img.okezone.com), a non-kanal okezone.com subdomain that republishes another brand's
//      content (mpi.okezone.com), a robots-disallowed /more/ path, and a non-article path —
//      proving the explicit allowlist doesn't "nyasar" (stray into) sibling brands or non
//      -article paths.
//   3. discover() + parse() both work fully offline (CRAWL_LIVE unset), and external_id is
//      present whenever the URL path carries an articleId.
//   4. parse() prefers the `?page=all` merge for a multipage article (proven via the
//      dedicated multipage-fixture assertions below) — NOT lossy page-1-only content.
//
// Usage: node fixtures/okezone/smoke-test.js
//   CRAWL_LIVE=true node fixtures/okezone/smoke-test.js   # also exercises live discover() +
//     the live `?page=all` fetch (a small handful of requests — see index.js header for the
//     exact endpoints hit).

const path = require('path');
const coreAdapter = require(path.join('..', '..', 'src', 'adapters', 'okezone', 'coreAdapter'));
const rawOkezone = require(path.join('..', '..', 'src', 'adapters', 'okezone'));

async function main() {
  const profile = coreAdapter.getSourceProfile();
  console.log('[okezone smoke] source profile:', JSON.stringify(profile, null, 2));

  if (!Array.isArray(profile.allowed_domains) || profile.allowed_domains.length === 0) {
    throw new Error('expected a non-empty allowed_domains allowlist on the source profile');
  }
  if (profile.allowed_domains.includes('*.okezone.com') || profile.allowed_domains.some((d) => d.startsWith('*'))) {
    throw new Error('expected allowed_domains to be an EXPLICIT allowlist, not a wildcard');
  }
  if (!profile.allowed_domains.includes('index.okezone.com')) {
    throw new Error('expected allowed_domains to include the discovery-only index.okezone.com host');
  }
  console.log(`[okezone smoke] allowed_domains (${profile.allowed_domains.length}): ${profile.allowed_domains.join(', ')}`);

  console.log('\n[okezone smoke] --- discover() (fixture-mode, CRAWL_LIVE unset) ---');
  const discoveryItems = await coreAdapter.discover({ sourceId: 'okezone', sourceProfile: profile, limit: 8 });
  console.log(`[okezone smoke] discovered ${discoveryItems.length} candidate url(s):`);
  for (const item of discoveryItems) {
    console.log(`  - [${item.channel}] ${item.url}`);
    console.log(
      `      title_hint: ${item.title_hint}  category_hint: ${item.category_hint}  external_id: ${item.external_id}  published_hint: ${item.published_hint}`
    );
  }
  if (discoveryItems.length === 0) {
    throw new Error('expected at least one discovered item from the bundled fixtures');
  }
  if (!discoveryItems.every((item) => item.external_id)) {
    throw new Error('expected every discovered item to carry an external_id (articleId parsed from the URL path)');
  }
  if (!discoveryItems.every((item) => item.published_hint)) {
    throw new Error('expected every discovered item to carry a parsed published_hint (Indonesian listing date -> ISO +07:00)');
  }

  const discoveredHosts = new Set(discoveryItems.map((item) => new URL(item.url).hostname));
  console.log(`[okezone smoke] discovered hosts: ${[...discoveredHosts].join(', ')}`);
  if (discoveredHosts.size < 2) {
    throw new Error(`expected discover() to span >=2 kanal subdomains by default, got: ${[...discoveredHosts].join(', ')}`);
  }
  if (!discoveredHosts.has('news.okezone.com') || !discoveredHosts.has('bola.okezone.com')) {
    throw new Error('expected discover() to include both news.okezone.com (kanal indeks) and bola.okezone.com (bydate channel)');
  }
  if (!discoveryItems.some((item) => item.channel.startsWith('kanal_indeks:'))) {
    throw new Error('expected at least one item tagged with the kanal_indeks: discovery channel');
  }
  if (!discoveryItems.some((item) => item.channel.startsWith('bydate_channel:'))) {
    throw new Error('expected at least one item tagged with the bydate_channel: discovery channel');
  }

  console.log('\n[okezone smoke] --- isArticleUrl() checks (multi-subdomain scope, no sibling-brand drift) ---');
  const isArticleChecks = [
    ['news.okezone.com /read/ URL', discoveryItems.find((i) => i.url.includes('news.okezone.com')).url, true],
    ['bola.okezone.com /read/ URL', discoveryItems.find((i) => i.url.includes('bola.okezone.com')).url, true],
    [
      'economy.okezone.com /read/ URL (3rd kanal, not in discovery fixtures but still in-scope)',
      'https://economy.okezone.com/read/2026/07/24/320/9300001/contoh-judul-berita-okezone-ekonomi',
      true,
    ],
    ['www.okezone.com hub-only (not a kanal, no /read/)', 'https://www.okezone.com/', false],
    ['www.okezone.com/indeks (404 live, not a kanal path)', 'https://www.okezone.com/indeks', false],
    ['bare kanal root, no /read/', 'https://news.okezone.com/nasional', false],
    ['/more/ robots-disallowed path', 'https://news.okezone.com/more/latest-updates', false],
    ['/mmore/ robots-disallowed path', 'https://bola.okezone.com/mmore/widget', false],
    ['/tag/ listing path', 'https://www.okezone.com/tag/kejagung', false],
    [
      'mpi.okezone.com (real okezone.com subdomain, republishes SINDOnews — a DIFFERENT brand)',
      'https://mpi.okezone.com/article/sindonews/9999999',
      false,
    ],
    ['img.okezone.com (asset host, not a kanal)', 'https://img.okezone.com/content/2026/07/24/337/9100001/foo.jpg', false],
    ['redaksi.okezone.com (author-profile host, not a kanal)', 'https://redaksi.okezone.com/detail/contoh-jurnalis/9999', false],
    [
      'inews.id (sibling MNC Media brand, different apex domain entirely)',
      'https://www.inews.id/sport/sepakbola/contoh-artikel-inews-brand-lain',
      false,
    ],
    ['sindonews.com (sibling MNC Media brand)', 'https://www.sindonews.com/topic/9999/contoh-artikel-sindonews', false],
  ];
  let sawTrueSubdomains = new Set();
  for (const [label, url, expected] of isArticleChecks) {
    const actual = coreAdapter.isArticleUrl(url);
    console.log(`  - ${actual}  <- [${label}] ${url}`);
    if (actual !== expected) {
      throw new Error(`isArticleUrl("${url}") [${label}]: expected ${expected}, got ${actual}`);
    }
    if (actual) sawTrueSubdomains.add(new URL(url).hostname);
  }
  if (sawTrueSubdomains.size < 2) {
    throw new Error('expected isArticleUrl() to return true for >=2 different kanal subdomains');
  }
  console.log(`[okezone smoke] isArticleUrl() true for ${sawTrueSubdomains.size} distinct kanal subdomain(s): ${[...sawTrueSubdomains].join(', ')}`);

  console.log('\n[okezone smoke] --- parse() (fixture, news.okezone.com, multipage via ?page=all) ---');
  const newsArticleUrl = 'https://news.okezone.com/read/2026/07/24/337/9100001/contoh-judul-berita-okezone-pertama';
  const newsArticle = await coreAdapter.parse(undefined, { url: newsArticleUrl });
  console.log(`[okezone smoke] title: ${newsArticle.title}`);
  console.log(`[okezone smoke] canonical_url: ${newsArticle.canonical_url}`);
  console.log(`[okezone smoke] external_article_id: ${newsArticle.external_article_id}`);
  console.log(`[okezone smoke] category: ${newsArticle.category}`);
  console.log(`[okezone smoke] tags: ${JSON.stringify(newsArticle.tags)}`);
  console.log(`[okezone smoke] published_at: ${newsArticle.published_at}`);
  console.log(`[okezone smoke] updated_at_source: ${newsArticle.updated_at_source}`);
  console.log(`[okezone smoke] field_provenance.content_text: ${JSON.stringify(newsArticle.field_provenance.content_text)}`);
  console.log(`\n[okezone smoke] content_text:\n${newsArticle.content_text}`);

  if (!newsArticle.title) throw new Error('expected title from fixture JSON-LD headline');
  if (newsArticle.canonical_url !== newsArticleUrl) {
    throw new Error(`expected canonical_url "${newsArticleUrl}" (page param stripped), got ${newsArticle.canonical_url}`);
  }
  if (newsArticle.external_article_id !== '9100001') {
    throw new Error(`expected external_article_id "9100001", got ${newsArticle.external_article_id}`);
  }
  if (newsArticle.category !== 'Nasional') {
    throw new Error(`expected category "Nasional" (from BreadcrumbList, correctly cased), got ${newsArticle.category}`);
  }
  if (!Array.isArray(newsArticle.tags) || newsArticle.tags.length !== 2) {
    throw new Error('expected exactly 2 tags from the fixture #tag .box-tag');
  }
  if (!newsArticle.published_at) throw new Error('expected published_at from JSON-LD datePublished (+07:00)');
  if (!newsArticle.updated_at_source) {
    throw new Error('expected updated_at_source parsed from the no-tz JSON-LD dateModified (assumed WIB)');
  }
  if (newsArticle.field_provenance.content_text.pages_detected !== 2) {
    throw new Error(`expected pages_detected === 2 (fixture #paging has 2 .nomor links), got ${newsArticle.field_provenance.content_text.pages_detected}`);
  }
  if (newsArticle.field_provenance.content_text.merged_via_page_all !== true) {
    throw new Error('expected merged_via_page_all === true (fixture-first ?page=all resolution)');
  }
  if (!newsArticle.content_text.includes('Paragraf keempat hanya muncul di halaman kedua')) {
    throw new Error('expected page-2-only content to be present in content_text, proving the ?page=all merge worked (no content loss)');
  }
  if (newsArticle.content_text.includes('Baca Juga') || newsArticle.content_text.includes('Contoh Artikel Republikasi Brand Lain')) {
    throw new Error('expected "Baca Juga" recirculation blocks to be stripped from content_text');
  }
  if (newsArticle.content_text.includes('youtube.com') || newsArticle.content_text.includes('iframe')) {
    throw new Error('expected .vicon embedded-video wrapper to be stripped from content_text');
  }
  if (newsArticle.language !== 'id') throw new Error(`expected language "id", got ${newsArticle.language}`);
  if (newsArticle.parser_version !== 'okezone_v1') {
    throw new Error(`expected parser_version "okezone_v1", got ${newsArticle.parser_version}`);
  }

  console.log('\n[okezone smoke] --- parse() (fixture, bola.okezone.com, SECOND kanal subdomain, single page) ---');
  const bolaArticleUrl = 'https://bola.okezone.com/read/2026/07/24/51/9200001/contoh-judul-berita-okezone-bola';
  const bolaArticle = await coreAdapter.parse(rawOkezoneReadFixture(rawOkezone.FIXTURE_ARTICLE_BOLA_PATH), {
    url: bolaArticleUrl,
  });
  console.log(`[okezone smoke] title: ${bolaArticle.title}`);
  console.log(`[okezone smoke] category: ${bolaArticle.category}`);
  console.log(`[okezone smoke] external_article_id: ${bolaArticle.external_article_id}`);
  console.log(`[okezone smoke] field_provenance.content_text: ${JSON.stringify(bolaArticle.field_provenance.content_text)}`);

  if (!bolaArticle.title) throw new Error('expected title from the bola fixture');
  if (bolaArticle.category !== 'Sepakbola Dunia') {
    throw new Error(`expected category "Sepakbola Dunia", got ${bolaArticle.category}`);
  }
  if (bolaArticle.external_article_id !== '9200001') {
    throw new Error(`expected external_article_id "9200001", got ${bolaArticle.external_article_id}`);
  }
  if (bolaArticle.field_provenance.content_text.pages_detected !== 1) {
    throw new Error('expected the bola fixture to be detected as single-page (no #paging widget)');
  }
  if (bolaArticle.content_text.includes('Contoh Artikel Brand Lain (iNews)')) {
    throw new Error('expected the "Baca Juga" link to a sibling brand (iNews) to be stripped from content_text');
  }

  if (process.env.CRAWL_LIVE === 'true') {
    console.log('\n[okezone smoke] --- discover() (CRAWL_LIVE=true) ---');
    const live = await rawOkezone.discover({ liveDiscover: true, limit: 5 });
    console.log(`[okezone smoke] live discover found ${live.items.length} item(s)`);
    for (const item of live.items.slice(0, 5)) {
      console.log(`  - [${item.discoveryChannel}] ${item.rawUrl}`);
    }
  }

  console.log('\n[okezone smoke] OK');
}

function rawOkezoneReadFixture(fixturePath) {
  // Local helper so this script doesn't need its own `fs`/`path` require dance for the one
  // extra fixture read (parse() itself already defaults to FIXTURE_ARTICLE_PATH when no html
  // is passed — this exercises the SECOND kanal fixture explicitly instead).
  // eslint-disable-next-line global-require
  return require('fs').readFileSync(fixturePath, 'utf8');
}

main().catch((err) => {
  console.error('[okezone smoke] FAILED:', err);
  process.exitCode = 1;
});
