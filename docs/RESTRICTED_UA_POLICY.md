# Restricted User-Agent Policy — BeritaSatu & Tribunnews

Sprint 7. Governs the browser-class User-Agent (UA) used for live HTTP against the two
sources whose edge WAF (CloudFront) blocks this crawler's normal UA. Docs only — see
`src/adapters/beritasatu/index.js` / `src/adapters/tribunnews/index.js` (module headers)
for the live-verification evidence this note summarizes, and `src/workers/lib/fetchHtml.js`
for the Sprint 7 shared-fetch wiring (owned by S7-A).

## 1. Scope

This policy applies **only** to two sources, both assessed `restricted` for the reason
below:

- `beritasatu` (`www.beritasatu.com`)
- `tribunnews` (`www.tribunnews.com`)

It is **not** the default UA behavior for any other adapter in this repo. Every other
source keeps using the shared `CRAWLER_UA` (default `EGIMediaCrawler/0.1`) plain product
token, exactly as `src/workers/lib/fetchHtml.js` already does.

It is also **not** the same thing as "go-after-permission" sources (Kompas, ANTARA,
iNews). Those are sources this project has chosen to hold off crawling live until
explicit publisher permission is obtained — a business/legal gate, unrelated to UA
shape. BeritaSatu/Tribunnews have no such gate; their only live-crawl blocker is a
technical WAF heuristic on the UA string, which this policy documents how to satisfy
honestly.

## 2. UA decision

Both sites' edge (CloudFront) was live-verified to 403 any non-browser-shaped UA —
including this crawler's own plain `EGIMediaCrawler/0.1` token, generic `curl` UAs, and
any UA containing the literal word "bot" — while a standard desktop Chrome UA string
gets a clean 200. Critically, a Chrome UA with the crawler's own product token honestly
**appended as a suffix** is also let through with 200. So the WAF check is "does the UA
look browser-shaped", not an exact-string allowlist.

Decision, in order of preference:

1. **Use**: a real desktop-Chrome-shaped UA string with `EGIMediaCrawler/0.1` appended,
   e.g.:

   ```
   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 EGIMediaCrawler/0.1
   ```

2. **Never** send the bare product token alone (`EGIMediaCrawler/0.1`) to these two
   hosts — verified live to 403.
3. **Never** spoof `Googlebot`, `bingbot`, or any other named crawler identity, even
   though both sites' robots.txt explicitly `Allow: /` for some of those — this crawler
   does not claim to be an identity it is not. It only borrows a browser-shaped prefix;
   the honest product token is always still present as a suffix.

This is a deliberate departure from every other adapter's plain `CRAWLER_UA` convention,
scoped narrowly to these two hosts because they are the only ones observed to require it.

## 3. Where it applies

- **Adapter-internal live discover** (`discover()` in each adapter, used when
  `ctx.liveDiscover === true` or `CRAWL_LIVE=true`) already sends this browser-class UA
  — this predates Sprint 7 and needs no change.
- **Sprint 7** wires the same UA convention into the shared `src/workers/lib/fetchHtml.js`
  `fetchArticleHtml()` path (used for the article-fetch stage of the pipeline, i.e.
  `crawl:once` / the `crawl-fetch` worker), so that live article fetches for these two
  sources also send the browser-class UA instead of falling through to the shared
  `CRAWLER_UA` that would 403. This is S7-A's implementation; this doc only specifies the
  policy it should follow.

## 4. Env overrides

| Source        | Env var                | Default (if unset)                                                                                                          |
| ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| beritasatu    | `BERITASATU_LIVE_UA`    | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 EGIMediaCrawler/0.1` |
| tribunnews    | `TRIBUNNEWS_LIVE_UA`    | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 EGIMediaCrawler/0.1` |
| everyone else | `CRAWLER_UA`            | `EGIMediaCrawler/0.1`                                                                                                         |

Note: as of Sprint 6b, `src/adapters/tribunnews/index.js`'s own `LIVE_UA` constant read
`TRIBUNNEWS_UA` (not `TRIBUNNEWS_LIVE_UA`). Sprint 7 (S7-A) has since renamed this to
`TRIBUNNEWS_LIVE_UA` for naming consistency with `BERITASATU_LIVE_UA` and with the shared
`fetchHtml.js` wiring described above — the table above already reflects the final name.
`beritasatu`'s existing `LIVE_UA` constant already read `BERITASATU_LIVE_UA` and needed no
rename.

Either override, if set, replaces the whole UA string — operators are responsible for
keeping any custom value browser-shaped and honestly suffixed with the product token if
they change it.

## 5. Rate / safety

- `src/workers/lib/fetchHtml.js`'s `fetchArticleHtml()` (the S7-A shared-fetch wiring, see
  module header) applies a small, env-overridable pause — `RESTRICTED_LIVE_FETCH_DELAY_MS`
  (default `800`ms) — before every live request to `beritasatu`/`tribunnews` specifically, via
  `restrictedFetchDelay()`. This is a minimal good-citizen pause, not a full rate limiter (see
  the next bullet for that); every other source gets no added delay.
- `CRAWL_LIVE=true` requires an explicit `--limit=N` (CLI) or `CRAWL_LIMIT` env var —
  enforced fail-fast by `src/core/crawlLimit.js` for every source, these two included.
  Never run a live crawl against either host without a limit.
- Keep a polite rate against these two specifically: start with `--limit=1`–`2` for any
  manual smoke check, and rely on the existing per-source rate limit
  (`src/queue/rateLimits.js`) for any queued/worker-driven crawl — don't lower it or
  bypass it for these hosts.
- Don't hammer: no parallel/concurrent live requests against `beritasatu`/`tribunnews`
  beyond what the normal single-source pipeline already issues sequentially.

## 6. Robots.txt (restated)

Live-verified `Disallow` prefixes for `User-agent: *`, already enforced in each adapter's
`isArticleUrl()`/`NON_ARTICLE_FIRST_SEGMENTS`:

- **BeritaSatu** (`www.beritasatu.com`): `/widget/`, `/widgets/`, `/tag/`, `/search/`,
  `/network/`.
- **Tribunnews** (`www.tribunnews.com`, **www-only** — the mobile mirror
  `m.tribunnews.com` and the ~40 separate regional Tribun Network domains are out of
  scope entirely, not just robots-disallowed): `/api/`, `/ajax/`, `/json/`, `/tag/`,
  `/topic/`, `/search`, plus (live-observed, also disallowed) `/posts/`, `/auth/`,
  `/member/`, `/komentar/`.

## 7. How to verify

Live smoke test with a hard limit of 1, against each source independently:

```bash
CRAWL_LIVE=true npm run crawl:once -- --source=beritasatu --limit=1
CRAWL_LIVE=true npm run crawl:once -- --source=tribunnews --limit=1
```

Expect: `[crawl-once]` logs a `200`-backed fetch (not a fixture fallback) and one article
`stored`/`duplicate`. To confirm the UA override plumbing itself instead of the default
string, set the source-specific env var to a distinguishable value first and check it
appears in the request (e.g. via a temporary logging proxy, or by trusting the adapter's
own live-fallback-to-fixture warning log if the override is malformed enough to 403):

```bash
CRAWL_LIVE=true BERITASATU_LIVE_UA="<custom-browser-shaped-UA> EGIMediaCrawler/0.1" \
  npm run crawl:once -- --source=beritasatu --limit=1

CRAWL_LIVE=true TRIBUNNEWS_LIVE_UA="<custom-browser-shaped-UA> EGIMediaCrawler/0.1" \
  npm run crawl:once -- --source=tribunnews --limit=1
```

If a run instead logs a live-fetch-failed warning and falls back to the bundled fixture,
treat that as a 403/WAF-block signal and re-check the UA string against §2 before
retrying.
