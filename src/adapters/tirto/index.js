'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Tirto.id (tirto.id) adapter — Sprint 3 (S3b). camelCase raw adapter, following the same
 * fixture-first pattern as `src/adapters/cnn_indonesia/index.js` / `src/adapters/liputan6/
 * index.js`. `src/adapters/tirto/coreAdapter.js` bridges this to the snake_case
 * `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct HTTP fetches —
 * `curl`/`axios` with a plain `User-Agent` such as `EGIMediaCrawler/0.1`, or a full desktop
 * browser UA string, both got HTTP 200 from tirto.id's Cloudflare front door; a bare, very
 * short generic UA string like `"Mozilla/5.0"` with no further tokens got HTTP 403 a few
 * times during exploration — worth knowing operationally, but irrelevant to this adapter's
 * own `CRAWLER_UA`, which already looks like a normal product UA):
 *
 *  - crawlable / go-with-limits. Scope restricted to the bare `tirto.id` host (no
 *    subdomains). `https://www.tirto.id/...` 301-redirects to the bare `https://tirto.id/...`
 *    (verified live), so `www.tirto.id` is accepted as an alias in `isArticleUrl()` but the
 *    bare host is canonical/authoritative everywhere else (`ALLOWED_HOST`, source profile
 *    `allowed_domains`). Tirto also runs a fully separate lifestyle vertical on its own
 *    domain, `diajeng.id` (surfaced inline among tirto.id's own `/indeks` listing items) —
 *    that is a different site/template entirely and is out of scope here; excluded simply by
 *    the host check, same treatment CNN Indonesia gives `tv.cnnindonesia.com`.
 *  - Discovery: `https://tirto.id/indeks` ("Indeks Artikel") is a single server-rendered
 *    listing that already mixes every channel (verified live: politics, economy, fact-check,
 *    "News Plus", video-with-text, history/"Mozaik", etc. all appear on one page) — this is
 *    used as the sole discovery source, analogous to detik/CNN's "Latest" page. `discover()`
 *    defaults to a small offline fixture listing (network-free); pass `ctx.liveDiscover =
 *    true` (or set `CRAWL_LIVE=true`) to opt into a live fetch, same convention as
 *    `cnn_indonesia/index.js`. **No further pagination is implemented on purpose**: Tirto's
 *    `robots.txt` (fetched live) carries `Disallow: *?next*`, and `/indeks` has no
 *    `?page=N`-style pagination of its own — its "load more" mechanism (confirmed absent
 *    from the initial SSR response) would rely on that disallowed `?next=<cursor>` query
 *    parameter, so this adapter never appends one; `ctx.channelUrl` can still override the
 *    listing URL (e.g. to point at a specific channel/category root) but always fetches it as
 *    a single, un-paginated page.
 *  - Article URL shape is FLAT (no `/{channel}/` path prefix, unlike detik/CNN/Liputan6):
 *    `https://tirto.id/{slug-words}-{code}`, e.g.
 *      https://tirto.id/bi-pertahankan-suku-bunga-acuan-575-persen-pada-juli-2026-hz5T
 *    `{code}` is always exactly 4 alphanumeric characters (mixed case; NOT a plain
 *    dictionary word in practice) and is reused as `external_article_id`. Because the shape
 *    is flat, it collides syntactically with tirto.id's own single-segment section/channel
 *    root pages (e.g. `/bisnis-tirto`, `/visual-tirto`, `/rilis-pers`, `/pikir-dua-kali`,
 *    `/indeks`, `/weekly`, `/kueri`, `/inception`, `/jangkar`) — verified live that these
 *    return a channel listing (`h1` "Indeks ...", zero `<article>`/`.content-text-editor`),
 *    NOT an article. Most are already excluded by the `{code}` being required to be exactly
 *    4 characters (e.g. `bisnis-tirto`/`visual-tirto` end in the 5-letter word "tirto") or by
 *    requiring 3+ hyphen-separated tokens (e.g. `rilis-pers` is only 2 tokens); the remaining
 *    ambiguous case, `pikir-dua-kali` (3 tokens, 4-letter last token), is excluded via the
 *    explicit `NON_ARTICLE_ROOT_SLUGS` set alongside the rest for clarity/robustness. Multi-
 *    segment paths (`/author/...`, `/tag/...`, `/news/...`, `/bisnis-tirto/insider/ekonomi`,
 *    `/q/latest-news-...`) are excluded outright by requiring exactly one path segment.
 *  - Article page has NO `NewsArticle` (or any `Article`) JSON-LD block (verified live across
 *    multiple samples — only `BreadcrumbList` + `Organization` are emitted). All metadata is
 *    sourced from Open Graph / custom meta tags + DOM:
 *      - title: DOM `h1.article-title` > `og:title` > `<title>`.
 *      - summary: `og:description` > `meta[name=description]` > DOM `p.kicker` (the dek/teaser
 *        directly under the headline; identical text to `og:description` live, kept as a
 *        last-resort fallback).
 *      - author: `meta[property="article:author"]` > DOM `.byline a.reporter-name` (verified
 *        live this is sometimes an institutional byline, e.g. "Tim Riset Tirto" on fact-check
 *        pieces — never rejected/blocked on that basis, same stance as CNN Indonesia's
 *        brand-only byline).
 *      - **published_at**: DOM `.byline div` text, "Terbit DD Mon YYYY HH:mm WIB" (month
 *        abbreviation observed live as the English 3-letter form — "Jul", "Aug", "Sep",
 *        "Nov", "Feb" — parsed defensively against both English and Indonesian abbreviations
 *        in `MONTH_INDEX`, `WIB` assumed => `+07:00`). This is the PRIMARY source and can
 *        differ from `updated_at_source` (verified live: one sample had "Terbit 2 Sep 2025
 *        17:00 WIB" while `article:modified_time` read "2025-09-15 17:10:15" — a real
 *        after-the-fact edit).
 *      - `updated_at_source`: `meta[property="article:modified_time"]`, format
 *        `"YYYY-MM-DD HH:MM:SS"` with no timezone marker — treated as Asia/Jakarta local time
 *        (same "no-tz means WIB" assumption `suara`/`viva` already make elsewhere).
 *      - `thumbnailUrl` <- `og:image`.
 *      - `category` <- breadcrumb DOM (`.breadcrumbs-wrapper a`, last/most-specific item,
 *        e.g. "Ekonomi", "News Plus", "Periksa Fakta"); no reliable URL-segment fallback
 *        exists since article URLs are flat (no `{channel}` path segment to fall back to).
 *      - `tags` <- `meta[name="news_keywords"]` (comma-separated). Verified live this field
 *        mixes REAL topical keywords with the article's own channel/taxonomy labels restated
 *        as keywords (e.g. `"...,flash news,ekonomi,bisnis tirto,insider"` for a piece
 *        breadcrumbed Bisnis > Insider > Ekonomi — note "bisnis tirto" itself never appears
 *        verbatim in that breadcrumb, only "Bisnis" does) — `extractTags()` filters out any
 *        keyword that case-insensitively matches a breadcrumb label OR one of Tirto's own
 *        rubric names (`TAXONOMY_LABEL_STOPWORDS`, gathered live from the site nav +
 *        `.postcard-label` values). This is a heuristic, kept low/medium confidence in the
 *        field matrix (see coreAdapter.js) — same spirit as Liputan6's `meta:keywords` tag
 *        gap.
 *  - Body text lives in DOM `.content-text-editor` (verified live selector; no
 *    `articleBody` in JSON-LD to fall back to, since there is none). Cleanup before
 *    extracting paragraphs: `script`/`style` (ad snippets are inlined this way), `ins[data-
 *    revive-*]` (Revive Ads), `[id^="gpt-inline"]`/`[id^="gpt-"]` (Google Publisher Tag ad
 *    slot `<div>`s), `.baca-holder` ("Baca juga:" related-article link lists), and
 *    `figcaption` (photo credit/caption text, kept out of the narrative body the same way
 *    every other pilot adapter here only walks `<p>` — inline `<img class="img-content">`
 *    tags are naturally excluded too since only `p`/`h2` text is pulled). In-body `<h2>`
 *    subheadings (verified live on longer News Plus-style pieces) are kept as paragraph-like
 *    entries so the structure isn't silently flattened.
 *  - **No multipage markup was found on any sampled live article** (no `[data-page]`
 *    equivalent, no "halaman 2" links) — every article ships as a single HTML document, so
 *    `parse()` never performs extra network I/O for pagination. `stripPageParam()` is still
 *    applied defensively before using a URL as `canonical_url`, mirroring every other
 *    adapter in this repo, in case some article template variant does paginate in future.
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as `cnn_indonesia/index.js`);
 * otherwise it returns the bundled fixture listing. `parse()` is fixture-first when no
 * `html` is supplied (or `ctx.fixtureOnly` is set), reading
 * `fixtures/tirto/sample-article.html`.
 */

const SOURCE_ID = 'tirto';
const BASE_URL = 'https://tirto.id/';
const ALLOWED_HOST = 'tirto.id';
const INDEKS_URL = 'https://tirto.id/indeks';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'tirto');
const FIXTURE_CHANNEL_PATH = path.join(FIXTURES_DIR, 'channel-indeks.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range

// Article URLs are flat: https://tirto.id/{word}(-{word})+-{4-char-code}. The 4-char code is
// required to be EXACTLY 4 characters (see module header on why this alone excludes most
// tirto.id section-root collisions like `/bisnis-tirto`, `/visual-tirto`), and at least 3
// hyphen-separated tokens are required overall (excludes 2-token roots like `/rilis-pers`).
// Host is pinned to tirto.id (bare + www alias) on purpose — see module header "Scope" note.
const ARTICLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+-[a-zA-Z0-9]{4}$/;

// Known single-segment section/channel root slugs and utility paths that are NOT articles
// (verified live: each renders a listing/utility page, zero `<article>`/`.content-text-
// editor`). `pikir-dua-kali` is the one root slug that would otherwise slip through
// ARTICLE_SLUG_PATTERN (3 tokens, 4-letter last token) — see module header.
const NON_ARTICLE_ROOT_SLUGS = new Set([
  'indeks',
  'news',
  'bisnis-tirto',
  'visual-tirto',
  'kueri',
  'inception',
  'rilis-pers',
  'jangkar',
  'pikir-dua-kali',
  'weekly',
  'author',
  'tag',
  'search',
  'q',
  'ajax',
  'apis',
  'pd',
  'documents',
  'onesignal',
  'embed',
]);

// Elements stripped from `.content-text-editor` before pulling `<p>`/`<h2>` text — see
// module header for rationale.
const BODY_NOISE_SELECTORS = [
  'script',
  'style',
  'ins',
  '[id^="gpt-inline"]',
  '[id^="gpt-"]',
  '.baca-holder',
  'figcaption',
];

// Tirto's own rubric/channel names (gathered live from the site nav — `.breadcrumbs-wrapper`
// — and the distinct `.postcard-label` values seen across `/indeks`), plus a couple of
// generic feed labels ("latest news", "latest sc") observed inside `meta[name=
// "news_keywords"]`. Verified live that `news_keywords` restates these alongside real
// topical keywords even when the label itself isn't part of THIS article's own breadcrumb
// trail (e.g. "bisnis tirto" for a piece breadcrumbed Bisnis > Insider > Ekonomi, or
// "sosial budaya" as a broader super-category not shown in a "News > News Plus" breadcrumb)
// — so `extractTags()` filters against this fixed list in addition to the live breadcrumb.
const TAXONOMY_LABEL_STOPWORDS = new Set([
  'latest news',
  'latest sc',
  'news',
  'bisnis',
  'bisnis tirto',
  'visual',
  'visual tirto',
  'kueri',
  'inception',
  'periksa fakta',
  'flash news',
  'news plus',
  'decode',
  'mozaik',
  'horizon',
  'miroso',
  'perspektif',
  'wawancara khusus',
  'insider',
  'side job',
  'sidejob',
  'gearbox',
  'byte',
  'edusains',
  'gws',
  'tirtoeco',
  'video',
  'vidpro',
  'video youtube',
  'esai foto',
  'infografik',
  'weekly',
  'tirto weekly',
  'ekonomi',
  'politik',
  'hukum',
  'sosial budaya',
  'mild report',
  'mesin waktu',
  'aktual dan tren',
  'binar',
  'siswa',
  'umum',
]);

// "Terbit DD Mon YYYY HH:mm WIB" — month abbreviation observed live as the English 3-letter
// form (Jul/Aug/Sep/Nov/Feb); Indonesian abbreviations are mapped too defensively in case
// older archived content (or a future template change) uses them instead.
const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  mei: 4,
  may: 4,
  jun: 5,
  jul: 6,
  jly: 6,
  agu: 7,
  ags: 7,
  aug: 7,
  sep: 8,
  sept: 8,
  okt: 9,
  oct: 9,
  nov: 10,
  des: 11,
  dec: 11,
};

// Fixture "listing" used by discover() when live discovery isn't requested. Mirrors what a
// real `/indeks` crawl would surface; parse() reads the bundled fixture file for the first
// entry regardless of the URL passed in (network-free default, same as cnn_indonesia/liputan6).
const FIXTURE_LISTING = [
  {
    rawUrl: 'https://tirto.id/contoh-judul-berita-tirto-pertama-hzAA',
    listingTitle: 'Contoh Judul Berita Tirto Pertama',
    publishedHint: '27 menit lalu',
    categoryHint: 'Ekonomi',
  },
  {
    rawUrl: 'https://tirto.id/contoh-judul-berita-tirto-kedua-hzBB',
    listingTitle: 'Contoh Judul Berita Tirto Kedua',
    publishedHint: '1 jam lalu',
    categoryHint: 'Politik',
  },
];

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'Tirto.id',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 30,
    overlapHours: 4,
    enabled: true,
  };
}

function isInScope(absoluteUrl) {
  try {
    const host = new URL(absoluteUrl).hostname.toLowerCase();
    return host === ALLOWED_HOST || host === `www.${ALLOWED_HOST}`;
  } catch (_err) {
    return false;
  }
}

function isArticleUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  if (!isInScope(url)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return false;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) {
    return false;
  }
  const slug = segments[0];
  if (NON_ARTICLE_ROOT_SLUGS.has(slug.toLowerCase())) {
    return false;
  }
  return ARTICLE_SLUG_PATTERN.test(slug);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url`. No live
 * multipage markup was found for Tirto (see module header) — this mirrors the invariant
 * every other adapter in this repo defends regardless.
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function stripPageParam(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('page');
    return parsed.toString();
  } catch (_err) {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string|undefined} the trailing 4-character code (e.g. "hz5T" from
 *   ".../hz5T"), used as `external_article_id`.
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const { pathname } = new URL(url);
    const slug = pathname.split('/').filter(Boolean)[0] || '';
    const match = /-([a-zA-Z0-9]{4})$/.exec(slug);
    return match ? match[1] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {{page?: string|number}} opts - reserved for a future `?page=` style param;
 *   currently a no-op since `/indeks` itself takes none (see module header "Discovery" note
 *   on why `?next=` pagination is deliberately never used).
 * @returns {string}
 */
function buildIndeksUrl(_opts = {}) {
  return INDEKS_URL;
}

/**
 * Parses an `/indeks` (or channel) listing page into discovery entries. Each entry is a
 * `<div class="postcard ..."><div class="postcard-caption"><div class="postcard-meta">
 * <div class="postcard-label">Kanal</div><div class="postcard-timestamp">N menit lalu</div>
 * </div><h3 class="postcard-title"><a href="...">Judul</a></h3></div></div>` (verified live
 * 2026-07-24). The timestamp is a relative Indonesian string ("N menit lalu", "Kemarin",
 * "Rabu, 22 Juli") with no absolute value anywhere in the listing markup — not parseable to
 * ISO 8601, so it is carried through as-is and left to fail `tryParseHint()` in
 * `coreAdapter.js` (same treatment Detik's real `indeks` discovery already gets there).
 * @param {string} html
 * @returns {Array<{rawUrl: string, listingTitle?: string, publishedHint?: string, externalId?: string, categoryHint?: string}>}
 */
function extractIndeksItems(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];

  $('.postcard').each((_, el) => {
    const $card = $(el);
    const $anchor = $card.find('.postcard-title a[href]').first();
    const href = $anchor.attr('href');
    if (!href || seen.has(href) || !isArticleUrl(href)) return;
    seen.add(href);

    items.push({
      rawUrl: href,
      listingTitle: $anchor.text().trim() || undefined,
      publishedHint: $card.find('.postcard-timestamp').first().text().trim() || undefined,
      externalId: extractExternalId(href),
      categoryHint: $card.find('.postcard-label').first().text().trim() || undefined,
    });
  });

  return items;
}

/**
 * @param {{limit?: number, discoverLimit?: number, channelUrl?: string, logger?: Object}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const indeksUrl = (ctx && ctx.channelUrl) || buildIndeksUrl();

  const response = await axios.get(indeksUrl, {
    headers: { 'User-Agent': CRAWLER_UA },
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'text',
  });

  if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
    return { items: [] };
  }

  const entries = extractIndeksItems(response.data).slice(0, limit);
  const items = entries.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: stripPageParam(entry.rawUrl),
    discoveryChannel: 'indeks',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    externalId: entry.externalId,
    categoryHint: entry.categoryHint,
  }));

  return { items };
}

async function discover(ctx) {
  if (isLiveDiscoverEnabled(ctx)) {
    try {
      const live = await discoverLive(ctx);
      if (live.items.length > 0) {
        return live;
      }
    } catch (err) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`tirto discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  const items = FIXTURE_LISTING.map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: entry.rawUrl,
    discoveryChannel: 'fixture',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    externalId: extractExternalId(entry.rawUrl),
    categoryHint: entry.categoryHint,
  }));

  return { items };
}

/**
 * @param {string} text - e.g. "Terbit 24 Jul 2026 11:00 WIB".
 * @returns {string|undefined} ISO 8601 string (assumes `WIB` => `+07:00`), or undefined if
 *   the text doesn't contain a recognizable "DD Mon YYYY HH:mm" fragment.
 */
function parseBylineDate(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * `article:modified_time` ships as `"YYYY-MM-DD HH:MM:SS"` with no timezone marker —
 * verified live this can legitimately differ from the DOM "Terbit" (published) timestamp
 * when an article is edited after publishing (see module header). Treated as Asia/Jakarta
 * local time, same "no-tz means WIB" assumption `suara`/`viva`/`cnn_indonesia` already make.
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function parseModifiedTime(value) {
  if (!value) return undefined;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = hasTz ? value : `${value.replace(' ', 'T')}+07:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]} breadcrumb labels in order, e.g. ["Beranda", "Bisnis", "Insider", "Ekonomi"]
 *   (verified live selector `.breadcrumbs-wrapper a`).
 */
function extractBreadcrumbLabels($) {
  return $('.breadcrumbs-wrapper a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
}

/**
 * @param {string[]} breadcrumbLabels
 * @returns {string|undefined} the most specific (last) breadcrumb label. No URL-segment
 *   fallback exists since Tirto article URLs are flat (see module header).
 */
function extractCategory(breadcrumbLabels) {
  return breadcrumbLabels.length > 0 ? breadcrumbLabels[breadcrumbLabels.length - 1] : undefined;
}

/**
 * Extracts `meta[name="news_keywords"]` (falling back to the identical `meta[name=
 * "keywords"]` live) and filters out anything that is really a restated channel/taxonomy
 * label rather than a topical tag — see module header for the live-verified rationale.
 * @param {cheerio.CheerioAPI} $
 * @param {string[]} breadcrumbLabels
 * @returns {string[]}
 */
function extractTags($, breadcrumbLabels) {
  const raw =
    $('meta[name="news_keywords"]').attr('content') || $('meta[name="keywords"]').attr('content') || '';
  const breadcrumbSet = new Set(breadcrumbLabels.map((label) => label.toLowerCase()));

  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => !breadcrumbSet.has(tag.toLowerCase()))
    .filter((tag) => !TAXONOMY_LABEL_STOPWORDS.has(tag.toLowerCase()));
}

/**
 * Removes known noise (ad slots/scripts, "Baca juga" blocks, image captions) from a clone of
 * the article body, then returns the cleaned-up `<p>`/`<h2>` text as paragraphs (in document
 * order; `<h2>` subheadings are kept so long-form structure isn't flattened away).
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio} bodyEl
 * @returns {string[]}
 */
function extractParagraphs($, bodyEl) {
  if (!bodyEl || bodyEl.length === 0) return [];

  const cleaned = bodyEl.clone();
  cleaned.find(BODY_NOISE_SELECTORS.join(', ')).remove();

  return cleaned
    .find('p, h2')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    FIXTURE_LISTING[0].rawUrl;

  const title =
    $('h1.article-title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author =
    $('meta[property="article:author"]').attr('content') ||
    $('.byline a.reporter-name').first().text().trim() ||
    undefined;

  const bylineText = $('.byline div').first().text().trim();
  const publishedAt = parseBylineDate(bylineText);
  const updatedAt = parseModifiedTime($('meta[property="article:modified_time"]').attr('content'));

  const summary =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('p.kicker').first().text().trim() ||
    undefined;

  const thumbnailUrl = $('meta[property="og:image"]').attr('content') || undefined;

  const breadcrumbLabels = extractBreadcrumbLabels($);
  const category = extractCategory(breadcrumbLabels);
  const tags = extractTags($, breadcrumbLabels);

  const externalArticleId = extractExternalId(url) || undefined;

  const bodyEl = $('.content-text-editor').first();
  const paragraphs = extractParagraphs($, bodyEl);

  return {
    sourceId: SOURCE_ID,
    url,
    title,
    author,
    publishedAt,
    updatedAt,
    summary,
    thumbnailUrl,
    category,
    tags,
    externalArticleId,
    paragraphs,
    rawHtml,
  };
}

module.exports = {
  getSourceProfile,
  isArticleUrl,
  discover,
  parse,
  // exported for unit tests / offline smoke script (fixtures/tirto/smoke-test.js) and for
  // debugging extraction logic in isolation.
  buildIndeksUrl,
  extractIndeksItems,
  extractExternalId,
  extractBreadcrumbLabels,
  extractCategory,
  extractTags,
  extractParagraphs,
  parseBylineDate,
  parseModifiedTime,
  stripPageParam,
  discoverLive,
  isLiveDiscoverEnabled,
  FIXTURE_CHANNEL_PATH,
  FIXTURE_ARTICLE_PATH,
};
