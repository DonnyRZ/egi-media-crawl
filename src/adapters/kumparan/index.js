'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cheerio = require('cheerio');
const axios = require('axios');

/**
 * Kumparan (kumparan.com) adapter — Sprint 4 (S4-B). camelCase raw adapter, following the
 * same fixture-first pattern as `src/adapters/tirto/index.js` / `src/adapters/cnn_indonesia/
 * index.js` / `src/adapters/liputan6/index.js`. `src/adapters/kumparan/coreAdapter.js` bridges
 * this to the snake_case `ParsedArticle` shape `src/core` (runPipeline) expects.
 *
 * Assessment notes this adapter encodes (verified live 2026-07-24 via direct `curl`/browser
 * fetches of real kumparan.com articles/channel pages + `robots.txt`, unless noted otherwise):
 *
 *  - crawlable / go. `robots.txt` (fetched live) carries NO `Disallow` rules for generic
 *    crawlers at all (only bot-specific `Allow: /` blocks for AI/search crawlers and a single
 *    `Allow: /.well-known/amphtml/apikey.pub` for `User-agent: *`) and publishes a full set of
 *    news/channel sitemaps (`sitemap_channel_news.xml` etc.) — a legitimate SECONDARY discovery
 *    channel this adapter does not implement yet (out of scope for this pass; noted for a
 *    future sprint). Scope restricted to the bare `kumparan.com` host only, per the task brief
 *    ("host-pin to kumparan.com"); `www.kumparan.com` was NOT verified as a working alias (live
 *    connection attempts during this pass timed out / failed to connect), so it is deliberately
 *    NOT accepted in `isArticleUrl()`.
 *  - **Discovery is GraphQL-backed, not HTML-scrapable**: verified live that `/channel/{slug}`
 *    (e.g. `https://kumparan.com/channel/bisnis`) server-renders only skeleton placeholder
 *    cards ("Sedang memuat...", "0 Suka· 0 Komentar·", a fixed dummy date "01 April 2020" on
 *    every card) — the real feed is fetched client-side. Network traffic capture (urlscan.io,
 *    this pass) confirms kumparan's web client talks to a persisted-query GraphQL API:
 *      - Reads: `GET https://cdn-graphql-v4.kumparan.com/query?operationName=<Op>&variables=<JSON>&extensions={"persistedQuery":{"version":1,"sha256Hash":"<hash>"}}`
 *      - Cache-miss/registration: `POST https://graphql-v4.kumparan.com/query` with a JSON body
 *        `{ operationName, variables, extensions, query }` (standard Apollo Automatic Persisted
 *        Queries flow — `extensions.persistedQuery.sha256Hash` must equal `sha256(query)`).
 *      - Real operations observed live (channel/topic feeds all use `cursorType: "PAGE"`):
 *        `FindStoryFeedByTopicSlug` (`{slug, size, cursorType:"PAGE", clientType:"WEB"}`),
 *        `FindAllChannelWidgetsOnHomepage` (`{cursorType:"PAGE", size, cursor}`),
 *        `FindAllChannels`, `FindAllVideoStories`. The specific per-channel feed operation name
 *        this adapter targets, per the task brief's prior assessment, is `FindContentFeed`
 *        (analogous shape: `{slug, cursorType:"PAGE", cursor, size}`) — urlscan.io's static
 *        capture only exposes REQUEST URLs, not response bodies, so the exact field names
 *        inside `findContentFeed`'s `edges[].node` were NOT independently confirmed against a
 *        captured live payload in this pass. `FIND_CONTENT_FEED_QUERY` below is a good-faith
 *        reconstruction following (a) the Relay-style `edges`/`node`/`pageInfo` connection
 *        shape every sibling operation above uses, and (b) the exact field names verified live
 *        on the article page itself (JSON-LD `NewsArticle`/`BreadcrumbList` — see below), since
 *        a content feed item is naturally a thin projection of the same article fields.
 *        `sha256Hash` is computed at runtime from `FIND_CONTENT_FEED_QUERY` (real APQ
 *        protocol), NOT copied from a captured live hash (none was observed) — so a live
 *        `discoverLive()` call may legitimately get `PersistedQueryNotFound` back if
 *        kumparan's server has a different canonical query string registered under that
 *        operation name; `fetchContentFeedGraphQL()` handles that by retrying once via the POST
 *        registration flow, and `discover()` falls back to the bundled fixture listing on any
 *        failure — same "live-attempt-then-fixture-fallback" convention as every other adapter
 *        in this repo, not a special case for Kumparan.
 *    Seeds are `https://kumparan.com/channel/{slug}` (default slug `news`; real channel slugs
 *    confirmed live via `robots.txt`'s per-channel sitemaps: news, entertainment, mom,
 *    food-travel, tekno-sains, otomotif, woman, bola-sports, bisnis, buzz, bolanita).
 *    `/terbaru` is NOT used as a listing seed (per task brief) — that path belongs to
 *    user-profile territory on kumparan.com, not a news index.
 *  - Article URL shape: `https://kumparan.com/{account}/{slug}-{shortId}`, e.g. (verified live,
 *    multiple real samples):
 *      https://kumparan.com/kumparannews/rano-karno-di-peringatan-30-tahun-kudatuli-keadilan-belum-selesai-27oRU1T1EYV
 *      https://kumparan.com/kumparanhits/elon-musk-berambisi-bikin-film-the-odyssey-pakai-grok-27qJ47LLsjo
 *      https://kumparan.com/yudhi-mada/teknik-penggunaan-kata-kunci-berbasis-lokasi-24ZGFhYmO7y
 *    `{account}` is the publishing account's handle — kumparan is a UGC-friendly platform, so
 *    this is sometimes a branded newsroom account (`kumparannews`, `kumparanhits`) and sometimes
 *    an individual contributor handle (`yudhi-mada`, `abigaelblandina13-sianipar`). `{shortId}`
 *    (the trailing dash-joined token) was **exactly 11 characters, always starting with 2
 *    digits, in every live sample checked** (`27oRU1T1EYV`, `27qJ47LLsjo`, `24ZGFhYmO7y`,
 *    `26Is3qTF0cm`, `27lGLgjDh77`) — encoded as `EXTERNAL_ID_PATTERN` below and reused as
 *    `external_article_id`. Because the URL has no `{channel}` path segment at all (flat,
 *    2-segment shape, same structural gap as Tirto's fully-flat URLs), `category` has NO
 *    URL-segment fallback and must come from the article page's own breadcrumb.
 *  - `/channel/{slug}` and `/topic/{slug}` are themselves syntactically 2-segment paths that
 *    would otherwise collide with the article shape above — excluded both by
 *    `RESERVED_FIRST_SEGMENTS` (defensive, explicit) AND, independently, because neither
 *    `channel`/`topic` slugs end in the required `-{11-char-shortId}` suffix.
 *  - Article page is JSON-LD-first (verified live, unlike CNN Indonesia/Liputan6's hybrid
 *    approach): a `NewsArticle` block carries `headline`, `image[]`, `datePublished`/
 *    `dateModified` (both full ISO 8601 **with an explicit `Z`/UTC offset already** — no
 *    "assume WIB" guessing needed here, unlike suara/viva/tirto), `author.name` (the REAL
 *    individual byline, e.g. "zamachsyari chawarazmi" — distinct from the publishing account
 *    name), `publisher.name`, `description`. A separate `BreadcrumbList` block carries
 *    `[WebSite, {channel WebPage, e.g. "News"/.../channel/news}, {account WebPage, e.g.
 *    "kumparanNEWS"/.../kumparannews}, {article WebPage}]` — `category` is sourced from the
 *    second-to-last-but-one item (the channel), see `extractBreadcrumbChannel()`. No
 *    `article:published_time`/`article:modified_time` OG meta tags were found live at all
 *    (JSON-LD is the sole timestamp source).
 *  - Body text lives in DOM `p[data-qa-id="story-paragraph"]` (verified live, stable
 *    `data-qa-id` test-hook attributes throughout kumparan's React app — `h1[data-qa-id=
 *    "story-title"]`, `[data-qa-id="author-name"]`, `time[data-qa-id="publish-date"]`,
 *    `figure[data-qa-id="image-figure"]` for inline images/captions). Because paragraph
 *    extraction is scoped directly to that `data-qa-id` selector (not a container walk), inline
 *    ad `<aside>` blocks and image `<figcaption>` captions (verified live to sit as siblings of,
 *    not nested inside, story paragraphs) are naturally excluded with no extra noise-stripping
 *    needed — a structural difference from CNN/Tirto/Liputan6, which all clean a shared
 *    container instead.
 *  - `summary` <- `meta[name="description"]` (clean) > JSON-LD `description` > `og:description`
 *    with a trailing `#newsupdate #news #update #text`-style hashtag block STRIPPED (verified
 *    live `og:description` always appends these; `meta[name=description]` never does — the two
 *    are otherwise identical text, so this is a real, observed discrepancy, not speculation).
 *  - `tags` <- the article footer's topic-link list, DOM `a[data-qa-id="tag-topic"] span[data-
 *    qa-id="label-tag-topic"]` (verified live selector, hrefs like `/topic/rano-karno`) — a
 *    clean, purpose-built tag list. `meta[name="keywords"]`/`news_keywords` were also verified
 *    live but are pure SEO keyword-stuffing (each real keyword repeated 3-4x as "Berita Terkini
 *    X", "Berita Terbaru X", "Berita Hari Ini X") and are used only as a last-resort fallback,
 *    de-duplicated, when the footer topic list is empty/absent.
 *  - `thumbnailUrl` <- JSON-LD `image[0]` > `og:image`.
 *  - **No live multipage markup was found** on the sampled live article (kumparan articles are
 *    single-document SPAs) — `parse()` still defensively strips any `?page=` query param before
 *    using a URL as `canonical_url`, mirroring every other adapter in this repo.
 *
 * SAFETY: `discover()` performs live HTTP only when `ctx.liveDiscover === true` or
 * `process.env.CRAWL_LIVE === 'true'` (same convention as every sibling adapter); otherwise it
 * reads the bundled `fixtures/kumparan/channel-feed.json` GraphQL response fixture and maps it
 * through the exact same `mapContentFeedResponseToItems()` a live response would go through.
 * `parse()` is fixture-first when no `html` is supplied (or `ctx.fixtureOnly` is set), reading
 * `fixtures/kumparan/sample-article.html`.
 */

const SOURCE_ID = 'kumparan';
const BASE_URL = 'https://kumparan.com/';
const ALLOWED_HOST = 'kumparan.com';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'kumparan');
const FIXTURE_FEED_PATH = path.join(FIXTURES_DIR, 'channel-feed.json');
const FIXTURE_ARTICLE_PATH = path.join(FIXTURES_DIR, 'sample-article.html');

const CRAWLER_UA = process.env.CRAWLER_UA || 'EGIMediaCrawler/0.1';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_LIMIT = 8; // within the requested 5-10 range
const DEFAULT_CHANNEL_SLUG = 'news';

// Real, live-confirmed persisted-query GraphQL endpoints (see module header "Discovery" note).
const GRAPHQL_READ_ENDPOINT = 'https://cdn-graphql-v4.kumparan.com/query';
const GRAPHQL_WRITE_ENDPOINT = 'https://graphql-v4.kumparan.com/query';
const FIND_CONTENT_FEED_OPERATION = 'FindContentFeed';

// Best-effort reconstruction of the FindContentFeed query — see module header for exactly what
// is/isn't independently verified here. Field selection mirrors the article-page JSON-LD shape
// (headline/image/datePublished/author/publisher) that IS verified live.
const FIND_CONTENT_FEED_QUERY = `query FindContentFeed($slug: String!, $cursorType: CursorTypeEnum!, $cursor: String, $size: Int) {
  findContentFeed(slug: $slug, cursorType: $cursorType, cursor: $cursor, size: $size) {
    edges {
      cursor
      node {
        id
        title
        slug
        shortId
        url
        publishedAt
        channel { slug name }
        account { username displayName }
        coverImage { url }
      }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

// Article URLs are flat 2-segment: https://kumparan.com/{account}/{slug-words}-{shortId}.
// {shortId} verified live as EXACTLY 11 chars, always starting with 2 digits (see module
// header "Article URL shape" note) — this is what makes the pattern discriminate real articles
// from `/channel/{slug}`, `/topic/{slug}`, and bare `/{account}` profile roots (none of which
// end in a matching suffix).
const EXTERNAL_ID_PATTERN = /-([0-9]{2}[A-Za-z0-9]{9})$/;
const ACCOUNT_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

// `/channel/{slug}` and `/topic/{slug}` are syntactically 2-segment paths that would otherwise
// need to fall through to EXTERNAL_ID_PATTERN to be excluded (and correctly would be, since
// neither slug ends in a valid shortId) — kept here too, explicitly, for clarity/robustness
// (same defensive-belt-and-suspenders style as tirto's NON_ARTICLE_ROOT_SLUGS).
const RESERVED_FIRST_SEGMENTS = new Set([
  'channel',
  'topic',
  'search',
  'about',
  'tentang-kumparan',
  'login',
  'register',
  'write',
  'app',
  'static',
  'newsroom',
  'partnership',
  'privacy-policy',
  'terms-of-service',
]);

// Indonesian full month names, as seen live in the DOM `publish-date` fallback string
// ("24 Juli 2026 10:15 WIB") — distinct from tirto's 3-letter abbreviations, this is the
// unabbreviated form. Used only as a fallback: JSON-LD `datePublished` (full ISO 8601 with an
// explicit UTC offset) is the primary source and needs no such parsing (see module header).
const MONTH_INDEX_ID = {
  januari: 0,
  februari: 1,
  maret: 2,
  april: 3,
  mei: 4,
  juni: 5,
  juli: 6,
  agustus: 7,
  september: 8,
  oktober: 9,
  november: 10,
  desember: 11,
};

function isLiveDiscoverEnabled(ctx) {
  return Boolean(ctx && ctx.liveDiscover === true) || process.env.CRAWL_LIVE === 'true';
}

function readFixture(fixturePath) {
  return fs.readFileSync(fixturePath, 'utf8');
}

function getSourceProfile() {
  return {
    sourceId: SOURCE_ID,
    displayName: 'kumparan',
    baseUrl: BASE_URL,
    timezone: 'Asia/Jakarta',
    crawlIntervalMinutes: 20,
    overlapHours: 3,
    enabled: true,
  };
}

function isInScope(absoluteUrl) {
  try {
    return new URL(absoluteUrl).hostname.toLowerCase() === ALLOWED_HOST;
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
  if (segments.length !== 2) {
    return false;
  }
  const [accountSegment, slugSegment] = segments;
  if (RESERVED_FIRST_SEGMENTS.has(accountSegment.toLowerCase())) {
    return false;
  }
  if (!ACCOUNT_SEGMENT_PATTERN.test(accountSegment)) {
    return false;
  }
  return EXTERNAL_ID_PATTERN.test(slugSegment);
}

/**
 * Defensive strip of a `page` query param before using a URL as `canonical_url`. No live
 * multipage markup was found for Kumparan (see module header) — this mirrors the invariant
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
 * @returns {string|undefined} the trailing 11-character shortId (e.g. "27oRU1T1EYV" from
 *   ".../27oRU1T1EYV"), used as `external_article_id`.
 */
function extractExternalId(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const { pathname } = new URL(url);
    const slug = pathname.split('/').filter(Boolean)[1] || '';
    const match = EXTERNAL_ID_PATTERN.exec(slug);
    return match ? match[1] : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {string} text - e.g. `hash(query)` computed from `FIND_CONTENT_FEED_QUERY`.
 * @returns {string} lowercase hex sha256 digest.
 */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildContentFeedVariables({ slug, cursor, size }) {
  return {
    slug,
    cursorType: 'PAGE',
    cursor: String(cursor === undefined || cursor === null ? '1' : cursor),
    size,
  };
}

/**
 * Real Apollo Automatic Persisted Queries (APQ) flow, per the live-observed request shapes in
 * the module header: try the cheap GET-with-hash-only read first; if the server doesn't
 * recognize the hash (`PersistedQueryNotFound`, or any other non-2xx/malformed response),
 * fall back to a POST that includes the full query text so the server can register it.
 * @param {{slug: string, cursor?: string|number, size?: number}} params
 * @returns {Promise<Object|null>} the raw GraphQL response envelope (`{data: {...}}`), or
 *   `null` if both the GET and the POST attempts failed.
 */
async function fetchContentFeedGraphQL({ slug, cursor, size }) {
  const variables = buildContentFeedVariables({ slug, cursor, size });
  const extensions = { persistedQuery: { version: 1, sha256Hash: sha256Hex(FIND_CONTENT_FEED_QUERY) } };

  try {
    const getResponse = await axios.get(GRAPHQL_READ_ENDPOINT, {
      params: {
        operationName: FIND_CONTENT_FEED_OPERATION,
        variables: JSON.stringify(variables),
        extensions: JSON.stringify(extensions),
      },
      headers: { 'User-Agent': CRAWLER_UA },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    });

    const persistedQueryMissing =
      getResponse.status >= 400 ||
      (Array.isArray(getResponse.data && getResponse.data.errors) &&
        getResponse.data.errors.some((e) => /persisted\s*query\s*not\s*found/i.test(e && e.message)));

    if (!persistedQueryMissing && getResponse.data && getResponse.data.data) {
      return getResponse.data;
    }
  } catch (_err) {
    // fall through to the POST/registration attempt below
  }

  try {
    const postResponse = await axios.post(
      GRAPHQL_WRITE_ENDPOINT,
      { operationName: FIND_CONTENT_FEED_OPERATION, variables, extensions, query: FIND_CONTENT_FEED_QUERY },
      {
        headers: { 'User-Agent': CRAWLER_UA, 'Content-Type': 'application/json' },
        timeout: HTTP_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );
    if (postResponse.status >= 200 && postResponse.status < 300 && postResponse.data && postResponse.data.data) {
      return postResponse.data;
    }
  } catch (_err) {
    // both attempts failed
  }

  return null;
}

/**
 * Maps a `FindContentFeed` GraphQL response envelope (live or fixture — same shape either way)
 * into raw discovery entries. Shared by `discoverLive()` and the offline fixture path in
 * `discover()` so both go through identical mapping logic.
 * @param {Object|null|undefined} graphqlResponse - `{data: {findContentFeed: {edges: [...]}}}`.
 * @param {{limit?: number, discoveryChannel?: string}} [opts]
 * @returns {Array<{rawUrl: string, normalizedUrl?: string, discoveryChannel: string, listingTitle?: string, publishedHint?: string, externalId?: string, categoryHint?: string}>}
 */
function mapContentFeedResponseToItems(graphqlResponse, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_DISCOVER_LIMIT;
  const discoveryChannel = opts.discoveryChannel || 'graphql_content_feed';

  const edges =
    (graphqlResponse &&
      graphqlResponse.data &&
      graphqlResponse.data.findContentFeed &&
      graphqlResponse.data.findContentFeed.edges) ||
    [];

  const items = [];
  for (const edge of edges) {
    if (items.length >= limit) break;
    const node = edge && edge.node;
    if (!node) continue;

    const account = node.account && node.account.username;
    const rawUrl = node.url || (account && node.slug && node.shortId
      ? `${BASE_URL}${account}/${node.slug}-${node.shortId}`
      : undefined);
    if (!rawUrl || !isArticleUrl(rawUrl)) continue;

    items.push({
      rawUrl,
      normalizedUrl: stripPageParam(rawUrl),
      discoveryChannel,
      listingTitle: node.title || undefined,
      publishedHint: node.publishedAt || undefined,
      externalId: node.shortId || extractExternalId(rawUrl),
      categoryHint: (node.channel && node.channel.name) || undefined,
    });
  }

  return items;
}

/**
 * @param {{limit?: number, channelSlug?: string, cursor?: string|number, logger?: Object}} [ctx]
 * @returns {Promise<{items: Array}>}
 */
async function discoverLive(ctx) {
  const limit = (ctx && ctx.limit) || DEFAULT_DISCOVER_LIMIT;
  const slug = (ctx && ctx.channelSlug) || DEFAULT_CHANNEL_SLUG;
  const cursor = (ctx && ctx.cursor) || '1';

  const graphqlResponse = await fetchContentFeedGraphQL({ slug, cursor, size: limit });
  if (!graphqlResponse) {
    return { items: [] };
  }

  return { items: mapContentFeedResponseToItems(graphqlResponse, { limit, discoveryChannel: 'graphql_content_feed' }) };
}

async function discover(ctx) {
  const limit = (ctx && ctx.limit) || DEFAULT_DISCOVER_LIMIT;

  if (isLiveDiscoverEnabled(ctx)) {
    try {
      const live = await discoverLive(ctx);
      if (live.items.length > 0) {
        return live;
      }
    } catch (err) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`kumparan discover: live discovery failed, falling back to fixture: ${err.message}`);
      }
    }
  }

  const fixtureJson = JSON.parse(readFixture(FIXTURE_FEED_PATH));
  const items = mapContentFeedResponseToItems(fixtureJson, { limit, discoveryChannel: 'fixture' });
  return { items };
}

/**
 * @param {string} raw - JSON-LD script text.
 * @returns {object[]}
 */
function parseJsonLdBlock($, el) {
  const raw = $(el).contents().text();
  if (!raw || !raw.trim()) return [];
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data['@graph'])) return data['@graph'];
    return data ? [data] : [];
  } catch (_err) {
    return [];
  }
}

function extractJsonLdBlocks($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    blocks.push(...parseJsonLdBlock($, el));
  });
  return blocks;
}

function findNewsArticleLd(blocks) {
  return blocks.find((block) => {
    const type = block && block['@type'];
    if (!type) return false;
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => typeof t === 'string' && /article/i.test(t));
  });
}

function findBreadcrumbLd(blocks) {
  return blocks.find((block) => block && block['@type'] === 'BreadcrumbList');
}

/**
 * Breadcrumb shape verified live: `[WebSite, {channel WebPage}, {account WebPage}, {article
 * WebPage}]` — the channel is always 3rd-from-last, the account 2nd-from-last, the article
 * itself always last. Indexing from the end (rather than assuming a fixed length of 4) is
 * defensive against a shorter/longer breadcrumb trail in some edge case.
 * @param {Object|undefined} breadcrumbLd
 * @returns {{name?: string, slug?: string}|undefined}
 */
function extractBreadcrumbChannel(breadcrumbLd) {
  const items = breadcrumbLd && Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  if (items.length < 3) return undefined;
  const entry = items[items.length - 3];
  const item = entry && entry.item;
  if (!item) return undefined;
  const idUrl = item['@id'];
  const slug = idUrl ? idUrl.split('/').filter(Boolean).pop() : undefined;
  return { name: item.name || undefined, slug };
}

/**
 * @param {Object|undefined} breadcrumbLd
 * @returns {{name?: string, slug?: string}|undefined} the publishing account (e.g.
 *   "kumparanNEWS" / "kumparannews") — 2nd-from-last breadcrumb item, see
 *   `extractBreadcrumbChannel()` doc.
 */
function extractBreadcrumbAccount(breadcrumbLd) {
  const items = breadcrumbLd && Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  if (items.length < 2) return undefined;
  const entry = items[items.length - 2];
  const item = entry && entry.item;
  if (!item) return undefined;
  const idUrl = item['@id'];
  const slug = idUrl ? idUrl.split('/').filter(Boolean).pop() : undefined;
  return { name: item.name || undefined, slug };
}

/**
 * Extracts the topic-tag list from the article footer, DOM `a[data-qa-id="tag-topic"]
 * span[data-qa-id="label-tag-topic"]` (verified live selector). Falls back to a de-duplicated
 * `meta[name="keywords"]`/`news_keywords` list only if the footer list is empty — see module
 * header for why that meta content is otherwise SEO keyword-stuffing, not a real tag list.
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractTopicTags($) {
  const fromFooter = $('a[data-qa-id="tag-topic"] span[data-qa-id="label-tag-topic"]')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  if (fromFooter.length > 0) {
    return fromFooter;
  }

  const raw = $('meta[name="keywords"]').attr('content') || $('meta[name="news_keywords"]').attr('content') || '';
  const seen = new Set();
  const deduped = [];
  for (const tag of raw.split(',').map((t) => t.trim()).filter(Boolean)) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(tag);
    }
  }
  return deduped;
}

/**
 * Strips the trailing `#hashtag #blocks` kumparan appends to `og:description` (verified live —
 * see module header) so it isn't mistaken for real summary text if it's ever used as a
 * fallback.
 * @param {string|undefined} text
 * @returns {string|undefined}
 */
function stripTrailingHashtags(text) {
  if (!text) return undefined;
  const stripped = text.replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '').trim();
  return stripped || undefined;
}

function toIsoOrUndefined(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {string} text - e.g. "24 Juli 2026 10:15 WIB" (verified live DOM fallback format).
 * @returns {string|undefined} ISO 8601 string (assumes `WIB` => `+07:00`), used only when
 *   JSON-LD `datePublished` is absent (see module header — this is the fallback, not primary).
 */
function parseDomPublishDate(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, day, monthRaw, year, hour, minute] = match;
  const monthIndex = MONTH_INDEX_ID[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:00+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * @param {string|string[]|undefined} image - JSON-LD `NewsArticle.image` (verified live to be
 *   an array of duplicate/near-duplicate URLs; sometimes a bare string in the schema.org spec).
 * @returns {string|undefined}
 */
function firstImage(image) {
  if (!image) return undefined;
  if (Array.isArray(image)) return image[0] || undefined;
  if (typeof image === 'string') return image;
  if (typeof image === 'object' && typeof image.url === 'string') return image.url;
  return undefined;
}

/**
 * Extracts `p[data-qa-id="story-paragraph"]` text, in document order (verified live selector —
 * see module header on why no extra noise-stripping is needed: ad `<aside>`s and image
 * `<figcaption>`s live as siblings, never nested inside a story paragraph).
 * @param {cheerio.CheerioAPI} $
 * @returns {string[]}
 */
function extractParagraphs($) {
  return $('p[data-qa-id="story-paragraph"]')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);
}

async function parse(html, ctx) {
  const useFixture = !(typeof html === 'string' && html.length > 0) || Boolean(ctx && ctx.fixtureOnly);
  const rawHtml = useFixture ? readFixture(FIXTURE_ARTICLE_PATH) : html;

  const $ = cheerio.load(rawHtml);
  const ldBlocks = extractJsonLdBlocks($);
  const articleLd = findNewsArticleLd(ldBlocks) || {};
  const breadcrumbLd = findBreadcrumbLd(ldBlocks);

  const url =
    (ctx && ctx.url) ||
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    (articleLd.mainEntityOfPage && articleLd.mainEntityOfPage['@id']) ||
    undefined;

  const title =
    articleLd.headline ||
    $('[data-qa-id="story-title"]').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const author =
    (articleLd.author && articleLd.author.name) ||
    $('[data-qa-id="author-name"]').first().text().trim() ||
    undefined;

  const publishedAt =
    toIsoOrUndefined(articleLd.datePublished) || parseDomPublishDate($('[data-qa-id="publish-date"]').first().text().trim());
  const updatedAt = toIsoOrUndefined(articleLd.dateModified);

  const summary =
    $('meta[name="description"]').attr('content') ||
    articleLd.description ||
    stripTrailingHashtags($('meta[property="og:description"]').attr('content')) ||
    undefined;

  const thumbnailUrl = firstImage(articleLd.image) || $('meta[property="og:image"]').attr('content') || undefined;

  const breadcrumbChannel = extractBreadcrumbChannel(breadcrumbLd);
  const category = (breadcrumbChannel && breadcrumbChannel.name) || undefined;
  const tags = extractTopicTags($);

  const externalArticleId = extractExternalId(url) || undefined;
  const paragraphs = extractParagraphs($);

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
  // exported for unit tests / offline smoke script (fixtures/kumparan/smoke-test.js) and for
  // debugging extraction logic in isolation.
  extractExternalId,
  extractJsonLdBlocks,
  findNewsArticleLd,
  findBreadcrumbLd,
  extractBreadcrumbChannel,
  extractBreadcrumbAccount,
  extractTopicTags,
  extractParagraphs,
  stripTrailingHashtags,
  parseDomPublishDate,
  stripPageParam,
  mapContentFeedResponseToItems,
  fetchContentFeedGraphQL,
  sha256Hex,
  discoverLive,
  isLiveDiscoverEnabled,
  FIND_CONTENT_FEED_QUERY,
  FIND_CONTENT_FEED_OPERATION,
  FIXTURE_FEED_PATH,
  FIXTURE_ARTICLE_PATH,
};
