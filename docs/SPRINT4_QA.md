# Sprint 4 QA — S4-E Quality Gate

**Verdict: GO**

**Scope:** Verify Tempo.co (S4-A), Kumparan (S4-B), and Jawa Pos (S4-C) are production-ready
for Sprint 4 (fixture path), and that S4-D's registry wiring didn't break the existing 6
adapters (detik/viva/suara/cnn_indonesia/liputan6/tirto). Fixture-only checks throughout —
`CRAWL_LIVE` was never set to `true` in this pass. Postgres was unavailable at the
`DATABASE_URL` value already present in the local `.env` (residual left by S3b-E, see "DB
environment note" below); a disposable local container was provisioned for this gate so the
store/upsert/idempotency checks could run for real instead of being skipped, then removed when
done.

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `assertAdapterShape` passes for `tempo`, `kumparan`, `jawa_pos` (+ prior 6 still pass) | ✅ PASS | A live `node -e` probe called `listAdapterIds()` → all **9** ids present (`['detik','viva','suara','cnn_indonesia','liputan6','tirto','tempo','kumparan','jawa_pos']`), then ran `assertAdapterShape(getAdapter(id))` for every one — all 9 passed (`discover`/`parse`/`isArticleUrl`/`getSourceProfile` all present as functions). No regression on the prior 6. |
| 2 | Fixture smoke: `node fixtures/{tempo,kumparan,jawa_pos}/smoke-test.js` (`CRAWL_LIVE` unset) | ✅ PASS | All three exit 0 and print `[<source> smoke] OK`. **Tempo**: discovers 3 candidates from the `_payload.json` fixture (FREE/FREE/VIP access hints), `isArticleUrl()` matrix correctly rejects rubric roots (`/ekonomi`), sub-rubrik listings (`/ekonomi/bisnis`, `/ekonomi/sinyal-pasar`, `/politik/pendidikan`), and the `penulis`/`tag` collision paths, accepts both `tempo.co`/`www.tempo.co`; free-article `parse()` yields 624-char `content_text` with `field_provenance` confidence `"high"`; a second inline-HTML VIP/Tempo-Plus sample correctly downgrades `content_text` confidence to `"low"` with an explanatory note, content is the short teaser as designed. **Kumparan**: discovers 6 candidates from the GraphQL `channel-feed.json` fixture (mix of branded + individual-contributor accounts); `ctx.limit` honored (limit=2 → 2 items); `isArticleUrl()` matrix rejects `/channel/*`, `/topic/*`, bare account root, and a slug with an invalid (non-11-char) shortId; `parse()` yields 1008-char `content_text`, distinct `published_at`/`updated_at_source` (both full ISO 8601 UTC). **Jawa Pos**: discovers 3 candidates from the `indeks.html` fixture via `__NEXT_DATA__`; `isArticleUrl()` matrix rejects `/indeks`, `/nasional`, `/sepak-bola-dunia` (category roots), `/search`, `/tag/...`, `/author/...`, and a non-10-digit id slug, accepts both `jawapos.com`/`www.jawapos.com`; `parse()` yields 769-char `content_text` including a mid-article `<h2>` subheading and content that survives past an in-body "Baca Juga" link and the client-side pagination marker; a separate offline GraphQL-deep-pagination fixture check (`graphql-articles-page2.json`) confirms the page-2 shape maps correctly (`hasMorePages: true`, 2 items) with no live network call made. |
| 3 | N5 snake_case — zero camelCase keys, required fields present | ✅ PASS | Called `coreAdapter.parse()` directly for all three and regex-scanned the returned object's keys (`/[a-z0-9]([A-Z])/`) — **zero** camelCase keys for each (15 keys: `external_article_id`, `canonical_url`, `title`, `summary`, `content_text`, `content_html`, `author_name`, `category`, `tags`, `thumbnail_url`, `published_at`, `updated_at_source`, `language`, `parser_version`, `field_provenance` — identical shape to tirto/liputan6/cnn_indonesia in prior gates). `canonical_url`, `title`, `content_text` all present and non-empty for all three. `adapter_version` present via `getSourceProfile().adapter_version` (`tempo_v1`, `kumparan_v1`, `jawa_pos_v1`) and mirrored onto `parser_version` on the parsed article — confirmed both in the direct probe and in the `sources`/`articles` tables after `crawl:once`. |
| 4 | `crawl:once` fixture path for tempo/kumparan/jawa_pos | ✅ PASS | `npm run crawl:once -- --source=<id> --limit=1` for all three → `stored (new_article)`, against a real (disposable, local) Postgres instance — `upsertArticle`/`storeParsedArticle` executed for real. `CRAWL_LIVE` left unset throughout. |
| 5 | Idempotent re-run | ✅ PASS | Ran the same `crawl:once` command a 2nd time for all three → `duplicate (duplicate_content)` for each. Verified directly in Postgres: `SELECT source_id, COUNT(*) FROM articles GROUP BY source_id` → **exactly 1 row** for `tempo`, `kumparan`, and `jawa_pos` after 2 runs each. Same dedup mechanism (`content_hash` + `articles_source_id_canonical_url_key` UNIQUE constraint) already proven for every prior source. |
| 6 | Regression — `listAdapterIds()` + prior sources | ✅ PASS | `listAdapterIds()` → all 9 ids present (see check 1). Went further than "optionally quick fixture crawl:once for one prior source": ran `npm run crawl:once --limit=1` for **5 of the 6** prior sources (`detik`, `suara`, `cnn_indonesia`, `liputan6`, `tirto`) against the same live DB — all `stored (new_article)` with no errors (the 6th, `viva`, was skipped only because this pass's tool-safety review flagged running a 4th extra non-required source as scope creep; the 5 already run are well beyond the "optionally one" bar and exercise a representative cross-section: flat-URL/multipage/JSON-LD-first/hybrid-DOM adapters). Final row-count check shows **exactly 1 row per source** for all 8 sources queried (`cnn_indonesia`, `detik`, `jawa_pos`, `kumparan`, `liputan6`, `suara`, `tempo`, `tirto`). The `sources` table shows all 8 rows with distinct `adapter_version` values. No adapter, core, or db source file was modified during this QA pass. |
| 7a | Tempo: offline discover works from `_payload.json` fixture (not empty/indeks-only) | ✅ PASS | `fixtures/tempo/rubric-payload.json` is a real Nuxt "devalue"-style payload array (verified by direct read) decoding to 3 full article-summary objects under `data['rubric-content'].latest.data` (ids `9100001`/`9100002`/`9100003`, titles, `canonical_url`, `published_at`, `access` hints FREE/FREE/VIP) — `discover()` (`CRAWL_LIVE` unset) correctly decodes this via `materializeNuxtValue()`/`extractRubricLatestItems()` and returns all 3 as discovery items with `discoveryChannel: 'fixture'`, confirming the fixture is a genuine payload sample, not an empty/`/indeks`-shaped stand-in (Tempo has no `/indeks` route at all, per the adapter's own live-verification notes — the payload-JSON path is the *only* discovery channel, live or fixture). |
| 7b | Kumparan: offline discover from GraphQL fixture JSON; live APQ residual noted | ✅ PASS (residual documented, non-blocking) | `fixtures/kumparan/channel-feed.json` is a `FindContentFeed`-shaped GraphQL response envelope (`{data: {findContentFeed: {edges: [...]}}}`, 6 edges) — `discover()` (`CRAWL_LIVE` unset) maps all 6 through `mapContentFeedResponseToItems()` correctly (accounts, shortIds, channel names, ISO timestamps all present). **Residual** (carried from S4-B, confirmed still accurate by reading `index.js`'s module header): the live `FindContentFeed` APQ query/hash is a good-faith reconstruction, not independently confirmed against a captured live response body — a real `discoverLive()` call may get `PersistedQueryNotFound` and, per `discover()`'s own fallback logic (`if (live.items.length > 0) return live;` else fall through), silently drop to the fixture listing. This is explicitly acceptable for Sprint 4's fixture-first scope (this gate never exercises `discoverLive()` at all, `CRAWL_LIVE` stayed unset) but is flagged again here for whoever eventually flips `CRAWL_LIVE=true` for kumparan. |
| 7c | Jawa Pos: parse uses `__NEXT_DATA__`; content_text non-empty from fixture | ✅ PASS | Confirmed by direct read of `index.js`'s `parse()`: `extractNextData()` regex-extracts and `JSON.parse()`s the `<script id="__NEXT_DATA__">` blob, then reads `props.pageProps.article` as the primary source for every field (title/summary/author/published_at/category/tags/thumbnail/content) — no JSON-LD `NewsArticle` block exists on this site at all (verified live per the module header: only `WebSite`+`NewsMediaOrganization` JSON-LD). Fixture `parse()` (`fixtures/jawa_pos/sample-article.html`) yields non-empty `content_text` (769 chars, 5 paragraphs including one `<h2>` subheading), confirming the `__NEXT_DATA__`-driven paragraph extraction (`extractParagraphsFromContent()`, which strips `p.page`/`p:has(strong.readmore)`/ad noise) works end-to-end offline. |
| 8 | Live safety | ✅ PASS (spot-check) | `CRAWL_LIVE` was never set to `true` at any point in this gate — every smoke-test/`crawl:once` invocation ran with it unset; `.env`'s `CRAWL_LIVE=false` confirmed unchanged before and after this pass (byte-identical). Spot-checked the fail-fast code path directly (not exercised live): `src/core/crawlLimit.js`'s `resolveDiscoverLimit({ liveCrawl: true })` with no explicit limit throws `"CRAWL_LIVE=true requires an explicit crawl limit..."` as expected. `src/workers/lib/fetchHtml.js`'s `FIXTURE_PATHS` includes entries for all 9 sources including `tempo`/`kumparan`/`jawa_pos` (fixture-first by default, live only opt-in via `CRAWL_LIVE=true`), same convention as every prior source. |

## GO criteria re-check

- **Tempo, Kumparan, and Jawa Pos each satisfy the core adapter contract** — yes, `assertAdapterShape` PASS for all three, all registered correctly in `src/adapters/index.js` and `src/workers/lib/fetchHtml.js`'s `FIXTURE_PATHS`.
- **Fixture path fully green (discover → parse → store → idempotent re-run) for all three** — yes, verified live end-to-end against a real (disposable) Postgres instance, not just statically read.
- **N5 contract respected (snake_case, required fields)** — yes, zero camelCase leakage for all three, all hard-required fields (`canonical_url`, `title`, `content_text`) present and non-empty; `adapter_version` correctly surfaced via each `getSourceProfile()`.
- **Batch-B-specific behaviors verified**: Tempo's `_payload.json`-based discovery is proven non-empty and not an `/indeks` stand-in; Kumparan's GraphQL-fixture discovery works offline with the live-APQ-uncertainty residual explicitly re-confirmed and documented (non-blocking, fixture-first is the Sprint 4 contract); Jawa Pos's `__NEXT_DATA__`-driven parse produces genuinely non-empty, noise-stripped `content_text`.
- **No regression on detik/suara/viva/cnn_indonesia/liputan6/tirto** — yes for the 5 sources actually re-run (detik/suara/cnn_indonesia/liputan6/tirto: all still load, pass `assertAdapterShape`, and store successfully via `crawl:once`); `viva` was not re-run via `crawl:once` in this pass (see check 6) but still passed `assertAdapterShape` and remains present in `listAdapterIds()`, so no registry-level regression risk exists for it either.
- **No live network crawl performed in this gate** — yes, `CRAWL_LIVE` stayed unset (`false`) throughout, confirmed unchanged in `.env` before/after; fail-fast code path spot-checked only, in isolation, without actually enabling live mode.

All criteria met → **GO**.

## DB environment note (not a blocker, but worth flagging — same pattern as S3-E / S3b-E)

- The `.env` checked into this workspace has `DATABASE_URL=postgresql://egi:egi@localhost:5434/egi_crawl`. At the start of this gate, port **5434** had nothing listening on it (the disposable container S3b-E created for `docs/SPRINT3B_QA.md` had already been removed after that gate, per its own documented cleanup step — expected, not a new issue). The only currently-running Postgres containers on this host at the time of this gate were `egi-postgres` (port 5433 — the **editorial EGI app database**, deliberately not touched/reused for crawler QA, per this task's explicit instruction), `makka-hotel-db-1` (internal 5432, unrelated project), and `orviko-postgres` (port 5432, unrelated project).
- Per this task's instruction, a fresh disposable container was provisioned (`egi_crawl_s4_qa`, `postgres:16-alpine`, port **5434** — deliberately reusing the same port the checked-in `.env` already pointed at, so no `.env` edit was needed at all — db `egi_crawl`, user/pass `egi`/`egi`, same convention as every prior gate's report), `npm run migrate` was run against it (both migrations applied cleanly), every DB-touching check above ran for real against it, and then the **container was removed** (`docker rm -f egi_crawl_s4_qa`) when done. `.env` itself was never edited during this pass.
- **Residual (carried forward, unchanged from S3-E/S3b-E):** `.env`'s `DATABASE_URL` in this workspace still reads `...@localhost:5434/egi_crawl`, which no longer exists (container removed after this QA pass, same disposable-cleanup convention as every prior gate). Whoever next needs a live DB for this repo should recreate it, e.g.:

  ```bash
  docker run --name egi_crawl_dev -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
  npm run migrate
  ```

  This is an environment/local-config issue, not an adapter or pipeline defect — it does not affect this gate's verdict since the DB path was fully exercised against a working (temporary) instance for every store/idempotency check.

## Residuals / follow-ups (non-blocking, carried from implementers + this gate)

1. **`.env`'s `DATABASE_URL` port drift** — see "DB environment note" above; carried forward from S3-E/S3b-E, environment/config hygiene issue only, not an adapter defect.
2. **Kumparan: live `FindContentFeed` GraphQL APQ hash may not match the server's registered query.** The adapter's own module header documents this candidly: the query text (`FIND_CONTENT_FEED_QUERY`) is a good-faith reconstruction (Relay-style `edges`/`node`/`pageInfo` shape, field names cross-checked against the live-verified article-page JSON-LD) since urlscan.io's static capture only exposed request URLs, not response bodies. If `discoverLive()` gets `PersistedQueryNotFound` back live, `fetchContentFeedGraphQL()` retries once via the POST registration flow; if that also fails, `discover()` silently falls back to the bundled fixture. This is fine/expected for Sprint 4's fixture-first scope (never exercised live in this gate) but should be re-verified with a real captured response before Kumparan's live discovery is ever relied upon in production.
3. **Jawa Pos: category-scoped GraphQL paging (`ArticleFilter.navbar`) 500s live.** Documented in the adapter's own module header as a live-verified backend bug on jawapos.com's side (tried multiple encodings — category slug, category UUID, with/without `publisherId` — all returned `{"errors":[{"message":"Internal server error"}]}`). Deep pagination beyond the unfiltered "latest across all categories" firehose (`filter: {publisherId}`, which DOES work live) is therefore not attempted for category-scoped discovery; a `ctx.categorySlug` run is capped at whatever that category's own SSR page returns (~10 items). Not exercised live in this gate (fixture-only), but a real limitation to keep in mind for future category-targeted crawling.
4. **Jawa Pos: no `updated_at_source` signal exists anywhere for this source** (verified live by the implementer: no `article:modified_time` meta tag, no modified/updated field on the GraphQL `Article` type) — always `undefined`, documented as a genuine coverage gap in the field matrix, not an extraction bug. Confirmed still accurate in this gate's fixture parse (`updated_at_source: undefined`).
5. **Tempo Plus / `isAccessibleForFree` truncated-content confidence downgrade.** Verified working as designed in this gate's smoke test: when JSON-LD `isAccessibleForFree === false` (Tempo Plus/VIP articles), `content_text`'s `field_provenance` confidence correctly drops to `"low"` with an explanatory note, and the extracted `content_text` is honestly just the short teaser paragraph — not a parsing bug, a real paywall signal. No dedicated N5 column exists for the paywall flag itself (by design, per `src/core/types.js`), so it is not invented as a new top-level field; downstream consumers should treat low-confidence `content_text` from Tempo as potentially teaser-only.
6. **Kumparan `category` has no URL-segment fallback** (article URLs are flat, `/{account}/{slug}-{shortId}`, no `{channel}` segment) — relies solely on the article's own `BreadcrumbList` JSON-LD. Documented as medium confidence; same structural gap already accepted for Tirto in a prior sprint.
7. **`viva` was not re-run via `crawl:once` in this pass** (see checklist item 6) — it still passed `assertAdapterShape` and is present in `listAdapterIds()`, so there is no evidence of a registry-level regression, but its store/idempotency path specifically was not re-exercised live in this gate (it was in `docs/SPRINT3B_QA.md`). Low risk: no code in `src/adapters/viva/**` was touched by Sprint 4 at all.

## How I verified (commands)

```bash
# Adapter shape + registry regression (all 9 sources)
node -e "const { getAdapter, listAdapterIds } = require('./src/adapters'); \
  const { assertAdapterShape } = require('./src/core/adapterContract'); \
  const ids = listAdapterIds(); console.log('ids:', ids); \
  for (const id of ids) { assertAdapterShape(getAdapter(id)); console.log(id, 'OK'); }"

# Fixture smoke tests (offline, no CRAWL_LIVE)
node fixtures/tempo/smoke-test.js
node fixtures/kumparan/smoke-test.js
node fixtures/jawa_pos/smoke-test.js

# N5 snake_case scan (ad hoc probe, not committed) — tempo/kumparan/jawa_pos
node -e "/* see report body: parses each coreAdapter directly, regex-scans keys for camelCase */"

# Disposable local Postgres for the store/idempotency checks (reuses .env's existing port,
# so no .env edit needed)
docker run --name egi_crawl_s4_qa -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
npm run migrate

# crawl:once fixture path for tempo/kumparan/jawa_pos, run 1 (stored) and run 2 (duplicate)
npm run crawl:once -- --source=tempo --limit=1      # x2
npm run crawl:once -- --source=kumparan --limit=1   # x2
npm run crawl:once -- --source=jawa_pos --limit=1   # x2

# Regression: 5 of 6 prior sources still store successfully
npm run crawl:once -- --source=detik --limit=1
npm run crawl:once -- --source=suara --limit=1
npm run crawl:once -- --source=cnn_indonesia --limit=1
npm run crawl:once -- --source=liputan6 --limit=1
npm run crawl:once -- --source=tirto --limit=1

# Row-count / idempotency confirmation (all 8 sources exercised)
docker exec egi_crawl_s4_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, COUNT(*) FROM articles GROUP BY source_id ORDER BY source_id;"
docker exec egi_crawl_s4_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, display_name, adapter_version FROM sources ORDER BY source_id;"

# field_provenance sanity check straight from the DB
docker exec egi_crawl_s4_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, canonical_url, jsonb_pretty(field_provenance->'content_text') \
   FROM articles WHERE source_id IN ('tempo','kumparan','jawa_pos') ORDER BY source_id;"

# Live-safety fail-fast spot-check (isolated, CRAWL_LIVE never actually set)
node -e "const { resolveDiscoverLimit } = require('./src/core'); \
  try { resolveDiscoverLimit({ explicitLimit: undefined, liveCrawl: true }); } \
  catch (e) { console.log('fail-fast OK:', e.message); }"

# Cleanup
docker rm -f egi_crawl_s4_qa
```

No adapter, core, or db source file was modified during this QA pass. `.env` was read but never
edited (its existing `DATABASE_URL` port happened to already match the disposable container
convention). The only artifact of this gate is this report.

---

## GO
Tempo, Kumparan, and Jawa Pos all pass adapter-shape, N5 snake_case, fixture smoke, and live-DB store/idempotency checks with no regression on the 6 prior sources — documented residuals (Kumparan APQ hash unverified live, Jawa Pos category-GraphQL 500s/no `updated_at_source`, Tempo Plus teaser downgrade) are all fixture-path-safe and non-blocking.
