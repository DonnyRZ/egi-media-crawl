'use strict';

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Jawa Pos (jawapos.com) adapter — Sprint 4 (S4-C). camelCase raw adapter, following the same
 * fixture-first pattern as `src/adapters/tirto/index.js` / `src/adapters/cnn_indonesia/
 * index.js`. `src/adapters/jawa_pos/coreAdapter.js` bridges this to the snake_case
 * `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct HTTP fetches —
 * plain `curl`/axios with a desktop-browser `User-Agent` got HTTP 200 throughout):
 *
 *  - crawlable / go-with-limits. Scope restricted to `jawapos.com` (bare, verified live:
 *    301-redirects to `www.jawapos.com`) and `www.jawapos.com` (canonical). `robots.txt`
 *    (fetched live) carries `Disallow: /fonts/`, `Disallow: /search`, `Disallow: /api/` — the
 *    `/api/` disallow is scoped to the `www.jawapos.com` origin only; the separate GraphQL
 *    host `api.jawapos.com` has its own `robots.txt` (fetched live) with an empty `Disallow:`,
 *    i.e. everything allowed — this adapter only ever calls `api.jawapos.com`, never
 *    `www.jawapos.com/api/*`, so it never runs afoul of that rule.
 *  - The site is a Next.js ("pages" router) app. EVERY page (listing, category, article)
 *    embeds a `<script id="__NEXT_DATA__" type="application/json">` blob with the exact
 *    server-fetched GraphQL data as `props.pageProps.*` — this is the PRIMARY data source for
 *    both discovery and parsing here, not DOM selectors and NOT JSON-LD (verified live: the
 *    only JSON-LD blocks present on an article page are `WebSite` and `NewsMediaOrganization`
 *    — there is no `NewsArticle`/`Article` JSON-LD block at all).
 *  - Discovery, primary: `https://www.jawapos.com/indeks` — SSR, `__NEXT_DATA__.props.
 *    pageProps.initialArticles` = `{ paginatorInfo: { hasMorePages }, data: Article[] }`,
 *    ~20 items per load (verified live). Secondary/category-scoped: `https://www.jawapos.com/
 *    {category-slug}` (e.g. `/nasional`, `/sepak-bola-dunia`) — a DIFFERENT Next.js route
 *    (`/[category]`) whose `__NEXT_DATA__.props.pageProps.categoryArticle` is a flat
 *    `Article[]` (~10 items) with a sibling boolean `pageProps.hasMore` (no `paginatorInfo`
 *    wrapper on this route, verified live). Both shapes are normalized by
 *    `extractListingFromNextData()` below. `?category=<slug>` on `/indeks` itself was tried
 *    live and consistently returned zero items regardless of a valid category slug — this
 *    looks like a real bug/gap on jawapos.com's own SSR route, so it is deliberately NOT
 *    relied upon; the dedicated `/{category-slug}` route is used instead for category scope.
 *  - Discovery, deep pagination: `/indeks`'s "Muat Lebih Banyak" ("Load More") button and
 *    plain `?page=N` query strings do NOT change the SSR response (verified live: `/indeks`
 *    ignores `?page=`) — matching the task brief's "HTML `?page=` is ineffective" note. The
 *    real deep-pagination path is the GraphQL endpoint `https://api.jawapos.com/api-jp-
 *    graphql` (introspection is enabled there and was used to confirm the exact shape live):
 *    `articles(filter: ArticleFilter, first: Int!, page: Int): ArticleSimplePaginator!`, where
 *    `ArticleSimplePaginator = { paginatorInfo: { hasMorePages }, data: Article[] }` — the
 *    SAME `Article` shape as `initialArticles`/`categoryArticle`. Verified live with
 *    `filter: { publisherId: "1" }` (jawapos.com's own `Publisher.id`, confirmed live from
 *    every sampled `Article.publisher`/`Article.category.publisher`) — `first: 20, page: N`
 *    pages cleanly through the full, unfiltered "latest across all categories" firehose with
 *    `hasMorePages` accurately reflecting more pages. **`ArticleFilter.navbar`** (apparently
 *    meant for category-scoped GraphQL paging, mirroring the task brief's "ArticlesFilter")
 *    was ALSO tried live with several encodings (category slug, category UUID, with/without
 *    `publisherId`) and consistently returned `{"errors":[{"message":"Internal server
 *    error",...}]}` — this looks like a genuine live backend bug, so category-scoped GraphQL
 *    paging is deliberately NOT attempted here (documented gap, same spirit as CNN
 *    Indonesia's unverified `?date=` listing param): `discoverLive()` only extends the
 *    unfiltered firehose via GraphQL; a `ctx.categorySlug` discovery run is capped at whatever
 *    that category's own `/{category-slug}` SSR page returns (~10 items).
 *  - Article URL shape: `https://www.jawapos.com/{category-slug}/{article_id}/{slug}`, e.g.
 *      https://www.jawapos.com/sepak-bola-dunia/2607240073/konser-pitbull-paksa-fk-kauno-zalgiris-pindah-kandang-mimpi-bermain-di-liga-champions-terganggu
 *    `{article_id}` is always exactly 10 digits (verified live across dozens of samples — the
 *    first 6 digits look date-encoded, `YYMMDD`, e.g. `260724` = 24 Jul 2026, followed by a
 *    4-digit daily sequence) and is reused as `external_article_id`. `{category-slug}` is
 *    NOT a stable "channel" segment the way it is for Tirto/CNN — the SAME article can be
 *    linked with different category slugs in different contexts (verified live: an in-body
 *    "Baca Juga" link used the article's OWN category slug, consistent with the canonical URL
 *    seen elsewhere) — this adapter always treats the URL actually surfaced by discovery (or
 *    the one derivable from the parsed article's own `category.slug`) as canonical, never
 *    tries to guess/rewrite `{category-slug}` independently.
 *  - Article page multi-page markup: `__NEXT_DATA__.props.pageProps` carries `currentPage`/
 *    `totalPages` (e.g. `1`/`2`) and the article's own `content` HTML contains a literal
 *    `<p class="page"></p>` marker — BUT verified live that requesting the SAME article URL
 *    with `?page=2` returns byte-for-byte IDENTICAL HTML to `?page=1` (diffed live, 237018
 *    bytes, exact match). So `totalPages`/`<p class="page">` is a CLIENT-side "split this
 *    already-complete HTML into reader pages" UI hint, not a signal that more content needs
 *    fetching — `content` already contains the full article body in one response. `parse()`
 *    therefore never performs extra network I/O for pagination; it only strips the empty
 *    `<p class="page"></p>` marker as noise (see `BODY_NOISE_SELECTORS`).
 *  - `content` (HTML string, inside `__NEXT_DATA__`) also embeds "Baca Juga: <a>...</a>"
 *    related-article links as `<p><strong class="readmore">Baca Juga: <a href="...">Title</a>
 *    </strong></p>` (verified live) — stripped before paragraph extraction the same way Tirto
 *    strips `.baca-holder`. A leading `<figure><img>...<figcaption>...</figcaption></figure>`
 *    (the cover photo, re-embedded inline) is naturally excluded from paragraphs because only
 *    `<p>`/`<h2>`/`<h3>` text is pulled (mirrors every other adapter's `<figcaption>` handling
 *    here, just without needing an explicit removal step since figures are never selected).
 *  - `updated_at`: no field for it was found anywhere (verified live: no `article:modified_
 *    time` meta tag, and `__NEXT_DATA__`'s `Article` GraphQL type has no modified/updated
 *    field) — `updated_at_source` is therefore always `undefined` for this source today. This
 *    is a genuine coverage gap (documented in `coreAdapter.js`'s field matrix), not a bug.
 *  - `published_at` ships as a no-timezone `"YYYY-MM-DD HH:MM:SS"` string (verified live,
 *    e.g. `"2026-07-24 08:10:08"`) — treated as Asia/Jakarta local time (`+07:00`), the same
 *    "no-tz means WIB" convention `suara`/`viva`/`tirto`/`cnn_indonesia` already use.
 *  - `author` <- `article.authors[].name` (GraphQL `Reporter[]`), joined with ", " when there
 *    is more than one; `category` <- `article.category.name`; `tags` <- `article.tags[].name`
 *    (GraphQL `Tag[]`, already a clean topical list — verified live no taxonomy-label noise
 *    the way Tirto's `news_keywords` meta has, so no stopword filtering is needed here).
 *  - `thumbnailUrl` <- `article.cover`. `summary` <- `article.description` (falls back to
 *    `og:description`/`meta[name=description]` only on the non-`__NEXT_DATA__` degraded path).
 *
 * SAFETY: `discoverLive()`/the GraphQL page-extension loop only run when `ctx.liveDiscover ===
 * true` or `process.env.CRAWL_LIVE === 'true'` (same convention as every other adapter here);
 * otherwise `discover()` returns the bundled fixture listing (`fixtures/jawa_pos/indeks.
 * html`), parsed through the exact same `__NEXT_DATA__` extraction code discovery uses live —
 * this fixture-first path is what proves the critical `__NEXT_DATA__` parsing logic offline.
 * `parse()` is fixture-first when no `html` is supplied (or `ctx.fixtureOnly` is set), reading
 * `fixtures/jawa_pos/sample-article.html`.
 */

const SOURCE_ID = 'jawa_pos';
const BASE_URL = 'https://www.jawapos.com/';
const ALLOWED_HOST = 'www.jawapos.com';
const ALT_HOST = 'jawapos.com'; // verified live: 301 -> www.jawapos.com
const INDEKS_URL = 'https://www.jawapos.com/indeks';
const GRAPHQL_URL = 'https://api.jawapos.com/api-jp-graphql';

// jawapos.com's own Publisher.id for the www.jawapos.com origin — verified live from every
// sampled Article.publisher / Article.category.publisher (`{"id":"1","name":"www.jawapos.com"}`).
const PUBLISHER_ID = '1';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'jawa_pos');
const FIXTURE_LISTING_PATH = path.join(FIXTURES_DIR, 'indeks.html');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range
const GRAPHQL_PAGE_SIZE = 20;
// Safety cap on how many extra GraphQL pages one discover() call may fetch, independent of
// ctx.limit — prevents a runaway loop if the API's hasMorePages ever misreports.
const MAX_GRAPHQL_PAGES = 25;

// Article URLs: https://www.jawapos.com/{category-slug}/{10-digit article_id}/{slug}. Host is
// pinned to jawapos.com + www.jawapos.com on purpose (see module header "Scope" note). The
// 10-digit, ALL-numeric middle segment is what makes this pattern safe against colliding with
// category root paths (e.g. `/piala-dunia-2026`, itself containing digits) or tag/author paths.
const ARTICLE_URL_PATTERN = /^https?:\/\/(?:www\.)?jawapos\.com\/[a-z0-9-]+\/\d{10}\/[a-z0-9-]+\/?(?:\?.*)?$/i;

// Defensive denylist for listing/utility paths, mirroring cnn_indonesia/index.js's style, even
// though ARTICLE_URL_PATTERN's 10-digit requirement already excludes all of these in practice.
const NON_ARTICLE_PATH_PATTERN = /\/(indeks|search|tag|author|login|subscription|foto|infografis)(\/|$|\?)/i;

// Elements/markers stripped from `article.content` before pulling `<p>`/`<h2>`/`<h3>` text —
// see module header for rationale (Baca Juga related-link paragraphs, the client-side reader
// pagination marker, and generic ad/script noise defensively).
const BODY_NOISE_SELECTORS = [
  'script',
  'style',
  'ins',
  'p.page',
  'p:has(strong.readmore)',
  '[id^="div-gpt-ad"]',
];

// Fixture "listing" used by discover() when live discovery isn't requested. Mirrors the shape
// a real /indeks crawl surfaces; parse() reads the bundled article fixture for the first entry
// regardless of the URL passed in (network-free default, same as tirto/cnn_indonesia).
const FIXTURE_LISTING_FALLBACK = [
  {
    rawUrl: 'https://www.jawapos.com/sepak-bola-dunia/2607240073/contoh-judul-berita-jawa-pos-pertama',
    listingTitle: 'Contoh Judul Berita Jawa Pos Pertama',
    publishedHint: '2026-07-24 08:10:08',
    externalId: '2607240073',
    categoryHint: 'Sepak Bola Dunia',
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
    displayName: 'Jawa Pos',
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
    return host === ALLOWED_HOST || host === ALT_HOST;
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
  if (NON_ARTICLE_PATH_PATTERN.test(url)) {
    return false;
  }
  return ARTICLE_URL_PATTERN.test(url);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url`. Verified live
 * that `?page=N` never changes the response (see module header) — this is purely hygiene,
 * mirroring the invariant every other adapter in this repo defends regardless.
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
 * @returns {string|undefined} the 10-digit `article_id` path segment.
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    const match = segments[1] && /^\d{10}$/.test(segments[1]) ? segments[1] : undefined;
    return match;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {{categorySlug?: string, articleId: string, slug: string}} parts
 * @returns {string|undefined}
 */
function buildArticleUrl({ categorySlug, articleId, slug } = {}) {
  if (!articleId || !slug) return undefined;
  const category = categorySlug || 'artikel';
  return `${BASE_URL}${category}/${articleId}/${slug}`;
}

/**
 * @param {string} categorySlug
 * @returns {string}
 */
function buildCategoryUrl(categorySlug) {
  return `${BASE_URL}${categorySlug}`;
}

/**
 * Locates and JSON.parses the `__NEXT_DATA__` script blob embedded in every jawapos.com page
 * (listing, category, or article) — see module header. This is the PRIMARY data source this
 * adapter relies on.
 * @param {string} html
 * @returns {Object|undefined}
 */
function extractNextData(html) {
  if (typeof html !== 'string' || html.length === 0) return undefined;
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch (_err) {
    return undefined;
  }
}

/**
 * Normalizes the two different listing shapes jawapos.com's Next.js routes embed in
 * `__NEXT_DATA__` (see module header "Discovery, primary"):
 *   - `/indeks`:        `pageProps.initialArticles = { paginatorInfo: { hasMorePages }, data }`
 *   - `/{category-slug}`: `pageProps.categoryArticle = Article[]`, sibling `pageProps.hasMore`
 * @param {Object|undefined} nextData
 * @returns {{articles: Array<Object>, hasMore: boolean}}
 */
function extractListingFromNextData(nextData) {
  const pageProps = nextData && nextData.props && nextData.props.pageProps;
  if (!pageProps) return { articles: [], hasMore: false };

  if (pageProps.initialArticles && Array.isArray(pageProps.initialArticles.data)) {
    return {
      articles: pageProps.initialArticles.data,
      hasMore: Boolean(
        pageProps.initialArticles.paginatorInfo && pageProps.initialArticles.paginatorInfo.hasMorePages
      ),
    };
  }

  if (Array.isArray(pageProps.categoryArticle)) {
    return {
      articles: pageProps.categoryArticle,
      hasMore: Boolean(pageProps.hasMore),
    };
  }

  return { articles: [], hasMore: false };
}

/**
 * Maps one GraphQL `Article` node (identical shape whether it came from `initialArticles`,
 * `categoryArticle`, or a live GraphQL `articles(...)` page) into a discovery entry.
 * @param {Object} article
 * @returns {{rawUrl: string, listingTitle?: string, publishedHint?: string, externalId?: string, categoryHint?: string}|undefined}
 */
function toDiscoveryEntry(article) {
  if (!article || !article.article_id || !article.slug) return undefined;
  const categorySlug = article.category && article.category.slug;
  const rawUrl = buildArticleUrl({ categorySlug, articleId: article.article_id, slug: article.slug });
  if (!rawUrl) return undefined;

  return {
    rawUrl,
    listingTitle: article.title || undefined,
    publishedHint: article.published_at || undefined,
    externalId: article.article_id,
    categoryHint: (article.category && article.category.name) || undefined,
  };
}

/**
 * Extracts discovery entries from a single listing/category page's raw HTML via its
 * `__NEXT_DATA__` blob (no DOM selectors involved — see module header).
 * @param {string} html
 * @returns {{entries: Array, hasMore: boolean}}
 */
function extractListingEntriesFromHtml(html) {
  const nextData = extractNextData(html);
  const { articles, hasMore } = extractListingFromNextData(nextData);
  const entries = articles.map(toDiscoveryEntry).filter(Boolean);
  return { entries, hasMore };
}

/**
 * Calls the live GraphQL endpoint for one page of the unfiltered "latest across all
 * categories" firehose (`filter: { publisherId }`) — see module header "Discovery, deep
 * pagination" on why this is the only GraphQL filter shape used (category-scoped `navbar`
 * filtering 500s live).
 * @param {{page: number, pageSize?: number}} opts
 * @returns {Promise<{articles: Array<Object>, hasMorePages: boolean}>}
 */
async function fetchGraphqlArticlesPage({ page, pageSize = GRAPHQL_PAGE_SIZE }) {
  const query = `
    query GetArticles($filter: ArticleFilter, $first: Int!, $page: Int) {
      articles(filter: $filter, first: $first, page: $page) {
        paginatorInfo { hasMorePages }
        data {
          article_id
          title
          slug
          description
          published_at
          category { name slug }
        }
      }
    }
  `;

  const response = await axios.post(
    GRAPHQL_URL,
    { query, variables: { filter: { publisherId: PUBLISHER_ID }, first: pageSize, page } },
    {
      headers: { 'User-Agent': CRAWLER_UA, 'Content-Type': 'application/json' },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    return { articles: [], hasMorePages: false };
  }

  const payload = response.data;
  if (!payload || payload.errors || !payload.data || !payload.data.articles) {
    return { articles: [], hasMorePages: false };
  }

  const { data, paginatorInfo } = payload.data.articles;
  return {
    articles: Array.isArray(data) ? data : [],
    hasMorePages: Boolean(paginatorInfo && paginatorInfo.hasMorePages),
  };
}

/**
 * @param {{limit?: number, discoverLimit?: number, channelUrl?: string, categorySlug?: string,
 *   logger?: Object}} [ctx] - `categorySlug` selects the `/{category-slug}` route instead of
 *   `/indeks`; `channelUrl` overrides the listing URL outright. `limit` (the `ctx.limit`
 *   convention shared with every adapter here) takes priority over `discoverLimit`.
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  const categorySlug = ctx && ctx.categorySlug;
  const listingUrl = (ctx && ctx.channelUrl) || (categorySlug ? buildCategoryUrl(categorySlug) : INDEKS_URL);

  const response = await axios.get(listingUrl, {
    headers: { 'User-Agent': CRAWLER_UA },
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'text',
  });

  if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
    return { items: [] };
  }

  const { entries, hasMore } = extractListingEntriesFromHtml(response.data);

  const seen = new Set(entries.map((entry) => entry.rawUrl));
  let stillHasMore = hasMore;

  // Deep pagination beyond the SSR page's ~20 (or ~10 for a category page) items is only
  // attempted for the unfiltered firehose (no categorySlug) — see module header on why
  // category-scoped GraphQL paging (`navbar` filter) is a documented live-verified gap.
  if (!categorySlug) {
    let page = 2;
    while (entries.length < limit && stillHasMore && page <= MAX_GRAPHQL_PAGES) {
      let graphqlResult;
      try {
        graphqlResult = await fetchGraphqlArticlesPage({ page, pageSize: GRAPHQL_PAGE_SIZE });
      } catch (err) {
        if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn(`jawa_pos discover: GraphQL page ${page} failed, stopping deep pagination: ${err.message}`);
        }
        break;
      }

      if (graphqlResult.articles.length === 0) break;

      for (const article of graphqlResult.articles) {
        const entry = toDiscoveryEntry(article);
        if (entry && !seen.has(entry.rawUrl)) {
          seen.add(entry.rawUrl);
          entries.push(entry);
        }
      }

      stillHasMore = graphqlResult.hasMorePages;
      page += 1;
    }
  }

  const items = entries.slice(0, limit).map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: stripPageParam(entry.rawUrl),
    discoveryChannel: categorySlug ? `category:${categorySlug}` : 'indeks',
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
        ctx.logger.warn(`jawa_pos discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  const limit = (ctx && (ctx.limit || ctx.discoverLimit)) || DEFAULT_DISCOVER_LIMIT;
  let entries;
  try {
    const html = readFixture(FIXTURE_LISTING_PATH);
    entries = extractListingEntriesFromHtml(html).entries;
  } catch (_err) {
    entries = [];
  }
  if (entries.length === 0) {
    entries = FIXTURE_LISTING_FALLBACK;
  }

  const items = entries.slice(0, limit).map((entry) => ({
    rawUrl: entry.rawUrl,
    normalizedUrl: entry.rawUrl,
    discoveryChannel: 'fixture',
    listingTitle: entry.listingTitle,
    publishedHint: entry.publishedHint,
    externalId: entry.externalId,
    categoryHint: entry.categoryHint,
  }));

  return { items };
}

/**
 * "YYYY-MM-DD HH:MM:SS" (no timezone marker, e.g. article.published_at) -> ISO 8601, assuming
 * Asia/Jakarta local time (`+07:00`) — same "no-tz means WIB" convention `suara`/`viva`/
 * `tirto`/`cnn_indonesia` already use. See module header on why this applies to jawa_pos too.
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function parseWibDateTime(value) {
  if (!value) return undefined;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = hasTz ? value : `${value.replace(' ', 'T')}+07:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Removes known noise (Baca Juga related-link paragraphs, the client-side reader-pagination
 * marker, ad/script noise) from a clone of `article.content`, then returns the cleaned-up
 * `<p>`/`<h2>`/`<h3>` text as paragraphs (in document order). The lead `<figure>`/
 * `<figcaption>` is naturally excluded since only `<p>`/`<h2>`/`<h3>` text is pulled.
 * @param {string|undefined} contentHtml
 * @returns {string[]}
 */
function extractParagraphsFromContent(contentHtml) {
  if (typeof contentHtml !== 'string' || contentHtml.length === 0) return [];

  const $ = cheerio.load(contentHtml);
  $(BODY_NOISE_SELECTORS.join(', ')).remove();

  return $('p, h2, h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);
  const nextData = extractNextData(rawHtml);
  const article = nextData && nextData.props && nextData.props.pageProps && nextData.props.pageProps.article;

  const domCanonical = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content');
  const nextDataUrl = article
    ? buildArticleUrl({
        categorySlug: article.category && article.category.slug,
        articleId: article.article_id,
        slug: article.slug,
      })
    : undefined;

  const url = (ctx && ctx.url) || nextDataUrl || domCanonical || FIXTURE_LISTING_FALLBACK[0].rawUrl;

  const title =
    (article && article.title) ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const authorNames =
    article && Array.isArray(article.authors)
      ? article.authors.map((a) => a && a.name).filter(Boolean)
      : [];
  const author = authorNames.length > 0 ? authorNames.join(', ') : undefined;

  const publishedAt = parseWibDateTime(article && article.published_at);
  // No modified/updated field exists anywhere for this source (verified live) — see module
  // header. Always undefined; documented as a genuine coverage gap, not an extraction bug.
  const updatedAt = undefined;

  const summary =
    (article && article.description) ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  const thumbnailUrl = (article && article.cover) || $('meta[property="og:image"]').attr('content') || undefined;

  const category = (article && article.category && article.category.name) || undefined;

  const tags =
    article && Array.isArray(article.tags) ? article.tags.map((t) => t && t.name).filter(Boolean) : [];

  const externalArticleId = (article && article.article_id) || extractExternalId(url) || undefined;

  const paragraphs = extractParagraphsFromContent(article && article.content);

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
  // exported for unit tests / offline smoke script (fixtures/jawa_pos/smoke-test.js) and for
  // debugging extraction logic in isolation.
  buildArticleUrl,
  buildCategoryUrl,
  extractNextData,
  extractListingFromNextData,
  extractListingEntriesFromHtml,
  toDiscoveryEntry,
  extractExternalId,
  extractParagraphsFromContent,
  parseWibDateTime,
  stripPageParam,
  discoverLive,
  isLiveDiscoverEnabled,
  fetchGraphqlArticlesPage,
  FIXTURE_LISTING_PATH,
  FIXTURE_ARTICLE_PATH,
};
