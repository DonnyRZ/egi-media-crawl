# Sprint 7 QA — S7-E Quality Gate

**Verdict: GO**

**Scope:** Verify the restricted-UA live-fetch path S7-A wired into
`src/workers/lib/fetchHtml.js` (`resolveUserAgent()`, `restrictedFetchDelay()`,
`RESTRICTED_LIVE_UA_BY_SOURCE`) actually gets a live HTTP **200** for `beritasatu` and
`tribunnews`, that the override is load-bearing (bare `CRAWLER_UA` still 403s), that the
fixture path is untouched when `CRAWL_LIVE` is unset, and that `docs/RESTRICTED_UA_POLICY.md`
(S7-P) is aligned with the final env-var names/behavior. This gate does **not** rebuild or
re-review the adapters themselves (Sprint 6b) beyond the specific live-fetch/UA/robots
behaviors called out below. No rewriting of adapters, no expanding the UA override to any
other source, and no permission-gated sources (Kompas/ANTARA/iNews) were touched.

Live HTTP was performed against `www.beritasatu.com`/`www.tribunnews.com` for this gate —
`CRAWL_LIVE=true` with a hard `limit` on every call, per the safety rule this same gate is
verifying. No parallel requests; one article per source, plus a bare-UA spot-check reusing
the same URL already fetched successfully (no extra distinct article fetched beyond that).

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | **Code**: `resolveUserAgent()`/restricted map covers exactly `beritasatu`+`tribunnews`; every other source defaults to `CRAWLER_UA` | ✅ PASS | Direct code read of `src/workers/lib/fetchHtml.js`: `RESTRICTED_LIVE_UA_BY_SOURCE` has exactly 2 keys (`beritasatu`, `tribunnews`), each importing the adapter's own exported `LIVE_UA` directly (not a duplicated literal). `resolveUserAgent(sourceId)` returns the map entry if present, else the shared `CRAWLER_UA`. Live probe: `resolveUserAgent('beritasatu')`/`resolveUserAgent('tribunnews')` → the Chrome-shaped UA string with `EGIMediaCrawler/0.1` appended; `resolveUserAgent('detik')` → bare `EGIMediaCrawler/0.1` (the shared default) — confirming no unintended scope creep to other sources. |
| 2 | **Live fetch 200**: `fetchArticleHtml('beritasatu', url)` / `fetchArticleHtml('tribunnews', url)` with `CRAWL_LIVE=true` | ✅ PASS | Discovered one real live article per source via each adapter's own `discover({ liveDiscover: true, limit: 3 })`, then called `fetchArticleHtml(sourceId, item.url)` directly (same function `crawl:once`/the `crawl-fetch` worker use). **BeritaSatu**: `https://www.beritasatu.com/internasional/3013582/as-pantau-ketat-mata-uang-10-negara-ini` → **status 200**, 158,757-byte body, 860ms total (includes the 800ms restricted-fetch delay), `fromCache: false` (real network fetch, not fixture). **Tribunnews**: `https://www.tribunnews.com/superskor/7858909/pssi-nya-argentina-minta-suporter-berdamai-dengan-kekalahan-tolak-narasi-ulang-lawan-spanyol` → **status 200**, 196,983-byte body, 1189ms total, `fromCache: false`. Both bodies are real, usable article HTML (JSON-LD + body-container markup present, consistent with each adapter's own `parse()` selectors). |
| 3 | **Bare UA still 403** (spot-check, proves override is load-bearing) | ✅ PASS (stronger than required — both hosts, not just one) | Re-requested the exact same two article URLs from check 2 with `axios.get(url, { headers: { 'User-Agent': process.env.CRAWLER_UA \|\| 'EGIMediaCrawler/0.1' } })` (the bare, non-restricted default): **beritasatu → 403**, **tribunnews → 403**. Confirms `resolveUserAgent()`'s per-source branch is genuinely load-bearing, not a no-op — without it, both live article fetches in check 2 would have 403'd instead of returning 200. |
| 4 | **Fixture regression**: `CRAWL_LIVE` unset → fixture path still works, instant, no live | ✅ PASS | With `process.env.CRAWL_LIVE` deleted (unset), `fetchArticleHtml('beritasatu', ...)` → status 200, 7,017-byte body, **1ms**, `fromCache: true`; `fetchArticleHtml('tribunnews', ...)` → status 200, 8,069-byte body, **0ms**, `fromCache: true`. Sub-millisecond timing and `fromCache: true` confirm these are bundled-fixture reads (`FIXTURE_PATHS['beritasatu']`/`['tribunnews']`), not network calls — `shouldUseFixture()` correctly short-circuits before `resolveUserAgent()`/`restrictedFetchDelay()` are ever reached. |
| 5 | **Robots**: `isArticleUrl()` rejects `Disallow` paths (spot-check) | ✅ PASS | Direct calls to each adapter's exported `isArticleUrl()`. **BeritaSatu**: `/widget/some-widget`, `/tag/bpjs-kesehatan`, `/search/foo`, `/network/foo` → all `false`; a real article path → `true`. **Tribunnews**: `/api/v1/foo`, `/tag/pilkada`, `/topic/covid-19`, `/search?q=foo`, `/komentar/123` → all `false`; a real article path → `true`. Matches each module's `NON_ARTICLE_FIRST_SEGMENTS` set and the robots.txt prefixes documented in both the adapters' own module headers and `docs/RESTRICTED_UA_POLICY.md` §6. |
| 6 | **Policy doc present and aligned with final env names** | ✅ PASS (after a minimal sync fix — see below) | `docs/RESTRICTED_UA_POLICY.md` existed but had two staleness issues, both fixed minimally in this pass (no other content touched): (a) §4's note still described the `TRIBUNNEWS_UA` → `TRIBUNNEWS_LIVE_UA` rename in **future tense** ("Sprint 7 (S7-A) should align this...") even though S7-A has already shipped that rename in `src/adapters/tribunnews/index.js` — reworded to past tense, clarifying the env-override table above it already reflects the final name; (b) §5 (Rate/safety) never mentioned `RESTRICTED_LIVE_FETCH_DELAY_MS` at all, even though that's the actual env var S7-A implemented for the "keep a polite rate" bullet already there — added one bullet naming the var, its default (800ms), and which function applies it (`restrictedFetchDelay()`). Confirmed via `grep` that the doc now contains no reference to the old `TRIBUNNEWS_UA` name (only the historical "used to read" mention, correctly past-tense) and does mention `RESTRICTED_LIVE_FETCH_DELAY_MS`. Env var names in the doc's §4 table (`BERITASATU_LIVE_UA`, `TRIBUNNEWS_LIVE_UA`, `CRAWLER_UA`) match `.env.example` and the adapters' own `process.env.*` reads exactly. |
| 7 | **Rate**: delay applied for restricted sources on live path | ✅ PASS | Code read: `restrictedFetchDelay(sourceId)` in `fetchHtml.js` awaits `sleep(RESTRICTED_FETCH_DELAY_MS)` (default 800ms, env-overridable via `RESTRICTED_LIVE_FETCH_DELAY_MS`) only when `RESTRICTED_LIVE_UA_BY_SOURCE[sourceId]` is truthy — i.e. only for `beritasatu`/`tribunnews`, called unconditionally before the `axios.get()` in `fetchArticleHtml()`, immediately after the fixture short-circuit. Timing check (optional, also performed): check 2's measured durations were 860ms (beritasatu) and 1189ms (tribunnews) for a single HTTP round-trip each — both comfortably ≥ the 800ms floor, consistent with the delay actually executing (a bare network round-trip to either site is well under 400ms on its own). Every other source's `RESTRICTED_LIVE_UA_BY_SOURCE[sourceId]` is `undefined`, so `restrictedFetchDelay()` resolves immediately for them — no added latency. |

## DB (nice-to-have, not a gate blocker)

- `.env`'s `DATABASE_URL` points at `localhost:5434`, which had nothing listening (confirmed:
  `crawl:once` failed fast with `ECONNREFUSED ... 5434`, the same actionable error
  `scripts/crawl-once.js`'s `assertDatabaseReady()` is designed to produce). A different,
  already-running `egi-postgres` container was found on port **5433**, but per this task's own
  guidance and the recurring convention from every prior gate (see e.g. `SPRINT6B_QA.md`'s "DB
  environment note"), that editorial container is left alone rather than reused/inspected for
  credentials, and provisioning a fresh disposable Postgres specifically for this pass was not
  pursued given the explicit fallback below.
- Per the task brief: *"if Postgres down, document and still GO if `fetchArticleHtml` live 200
  is proven."* That condition is met — checks 2/3/4 above call `fetchArticleHtml()` directly
  (the exact function `crawl:once`/`crawl-fetch` use) and prove live 200 + load-bearing UA +
  fixture regression, entirely independent of the DB. `crawl:once --limit=1` end-to-end
  store/idempotency for `beritasatu`/`tribunnews` was therefore **not** exercised in this gate —
  carried forward as a residual, not a blocker.

## GO criteria re-check

- **`resolveUserAgent()` covers exactly the two restricted sources, no scope creep** — yes (check 1).
- **Live fetch 200 for both `beritasatu` and `tribunnews` via `fetchArticleHtml()`** — yes (check 2), with a hard `limit` on every live call (`discover({ limit: 3 })`, single article fetched per source).
- **Override is load-bearing (bare UA 403s)** — yes, on **both** hosts (check 3), stronger than the "at least one" requirement.
- **Fixture path (`CRAWL_LIVE` unset) unaffected** — yes, instant + `fromCache: true` for both (check 4).
- **Robots-disallowed paths rejected** — yes, spot-checked for both sources (check 5).
- **Policy doc present and aligned** — yes, after the two minimal sync fixes described in check 6 (no other doc content changed).
- **Rate/delay applied for restricted sources only** — yes, by code read and timing (check 7).
- **DB store**: not proven this pass (Postgres unreachable at the configured port) — explicitly non-blocking per the task brief's own DB fallback clause, since live-200 is independently proven.

All required, in-scope criteria met → **GO**.

## Out of scope (confirmed not touched)

- No adapter (`src/adapters/beritasatu/*`, `src/adapters/tribunnews/*`) rewriting — only read for verification.
- No expansion of the UA override map beyond `beritasatu`/`tribunnews` — confirmed by code read (check 1).
- No permission-gated source (Kompas/ANTARA/iNews) crawled or referenced live.

## Residuals / follow-ups (non-blocking)

1. **`.env`'s `DATABASE_URL` port drift (5434, nothing listening)** — same recurring environment/config-hygiene issue flagged in every prior gate since S3-E (see `SPRINT6B_QA.md` §"DB environment note"). Not fixed in this pass since this gate's DB check is explicitly nice-to-have and the live-fetch proof did not require it. Whoever next needs a live DB for this repo should provision a disposable Postgres on that port and run `npm run migrate`.
2. **`crawl:once --limit=1` end-to-end store/idempotency for `beritasatu`/`tribunnews` under `CRAWL_LIVE=true` was not exercised** — `fetchArticleHtml()` was called directly instead (same function, no DB required). A future pass with a working DB should run the full `CRAWL_LIVE=true npm run crawl:once -- --source=<beritasatu|tribunnews> --limit=1` command per `docs/RESTRICTED_UA_POLICY.md` §7 to additionally confirm the store/dedup path against these two sources' live HTML end-to-end.
3. **This gate re-verified live 200 against the same two real-world article URLs discovered at gate time** (2026-07-24) — CloudFront's WAF heuristic could change in the future; this is a point-in-time live-verification, same caveat every adapter's own module header already carries for its live-site claims.
4. **No independent 3rd-party re-verification of the adapters' own structural claims** (discovery shapes, JSON-LD fields, pagination caps, etc.) — out of scope for this gate, which is specifically about the S7-A live-fetch/UA/rate wiring and S7-P doc alignment, not a re-review of Sprint 6b's adapter internals.

## How I verified (commands/method)

- Direct code read: `src/workers/lib/fetchHtml.js`, `src/adapters/beritasatu/index.js`, `src/adapters/tribunnews/index.js`, `src/core/crawlLimit.js`, `scripts/crawl-once.js`, `docs/RESTRICTED_UA_POLICY.md`, `.env.example`, `.env`.
- A temporary Node script (`process.env.CRAWL_LIVE='true'`) called each adapter's `discover({ liveDiscover: true, limit: 3 })` to get one real live article URL per source, then `fetchArticleHtml(sourceId, url)` directly from `src/workers/lib/fetchHtml.js` — status/body-length/timing captured (check 2), then `process.env.CRAWL_LIVE` deleted and the same function re-called to confirm the fixture path (check 4). `resolveUserAgent()` was probed directly for `beritasatu`/`tribunnews`/`detik` (check 1).
- A bare-UA spot-check re-requested the same two discovered URLs directly via `axios.get()` with the plain `CRAWLER_UA` header (check 3).
- A second temporary script called `isArticleUrl()` directly on a matrix of robots-disallowed and real article paths for both sources (check 5).
- Both temporary scripts were deleted after use; no scratch files were left in `scripts/`.
- `npm run crawl:once -- --source=beritasatu` (fixture path, no `--limit`) was run once to observe the DB-connectivity failure mode directly (documented in "DB" section above) — no live network or DB write occurred from this call since it failed at the `assertDatabaseReady()` step before reaching discovery/fetch.
- `docs/RESTRICTED_UA_POLICY.md` was edited minimally (two localized changes, see check 6) — no other section rewritten.
