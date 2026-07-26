# Sprint 3b QA — S3b-E Quality Gate

**Verdict: GO**

**Scope:** Verify Tirto.id (S3b) is production-ready for Sprint 3b (fixture path), and that
S3b-D's registry wiring didn't break the existing 5 adapters (detik/viva/suara/cnn_indonesia/
liputan6). Fixture-only checks throughout — `CRAWL_LIVE` was never set to `true` in this pass.
Postgres was unavailable at the `DATABASE_URL` value already present in the local `.env` (see
"DB environment note" below, same residual left by S3-E); a disposable local container was
provisioned for this gate so the store/upsert/idempotency checks could run for real instead of
being skipped, then removed when done.

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `assertAdapterShape` passes for `tirto` (+ prior 5 still pass) | ✅ PASS | `getAdapter('tirto')` (via `src/adapters/index.js`, resolving to `./tirto/coreAdapter`) has `discover`/`parse`/`isArticleUrl` as functions and passed `src/core/adapterContract.js`'s `assertAdapterShape()` in a live `node -e` probe. Same probe iterated `listAdapterIds()` (`['detik','viva','suara','cnn_indonesia','liputan6','tirto']`) and confirmed all 6 pass — no regression on the prior 5. |
| 2 | Fixture smoke test | ✅ PASS | Ran `node fixtures/tirto/smoke-test.js` directly (`CRAWL_LIVE` unset) — exits 0, prints `[tirto smoke] OK`. Its own internal assertions passed with no code changes needed: non-empty `title`/`canonical_url`/`content_text`/`summary`/`thumbnail_url`; `isArticleUrl()` true/false matrix (article URL, `/indeks`, `/bisnis-tirto`, `/visual-tirto`, `/rilis-pers`, `/pikir-dua-kali`, multi-segment category path, `/author/...`, out-of-scope `diajeng.id`, `www.tirto.id` alias) all resolved as expected; "Baca juga" and figcaption noise excluded from `content_text`; in-body `<h2>` subheading kept; `published_at` (11:00 "Terbit") differs from `updated_at_source` (14:12 `article:modified_time`) as the fixture is designed to prove; tag filtering removed breadcrumb/taxonomy-label restatements (`ekonomi`, `bisnis tirto`, `insider`, `flash news`) while keeping the real topical keyword (`suku bunga acuan`); `category` = `"Ekonomi"` (last breadcrumb item). |
| 3 | N5 snake_case — zero camelCase keys, required fields present | ✅ PASS | Called `coreAdapter.parse()` directly and regex-scanned the returned object's keys (`/[a-z0-9]([A-Z])/`) — **zero** camelCase keys (15 keys total: `external_article_id`, `canonical_url`, `title`, `summary`, `content_text`, `content_html`, `author_name`, `category`, `tags`, `thumbnail_url`, `published_at`, `updated_at_source`, `language`, `parser_version`, `field_provenance`), matching the exact key-count/shape pattern already verified for cnn_indonesia/liputan6 in `docs/SPRINT3_QA.md`. `canonical_url`, `title`, `content_text` are all present and non-empty; `adapter_version` is present via `getSourceProfile().adapter_version` (`"tirto_v1"`, confirmed in a separate probe and in the `sources` table after `crawl:once`). `published_at` is present (soft-required field, not just fine-if-absent) — `2026-07-24T04:00:00.000Z` from the fixture's "Terbit 24 Jul 2026 11:00 WIB" byline. |
| 4 | `crawl:once` fixture path | ✅ PASS | `npm run crawl:once -- --source=tirto --limit=1` → `stored (new_article)`, against a real (disposable, local) Postgres instance — `upsertArticle`/`storeParsedArticle` executed for real, not just parse-checked. `CRAWL_LIVE` left unset. |
| 5 | Idempotent re-run | ✅ PASS | Ran the same `crawl:once` command a 2nd time → `duplicate (duplicate_content)`. Verified directly in Postgres: `SELECT source_id, COUNT(*) FROM articles WHERE source_id='tirto'` → **exactly 1 row** after 2 runs. Same dedup mechanism (`content_hash` + `articles_source_id_canonical_url_key` UNIQUE constraint) already proven for the pilots and Sprint 3 sources. |
| 6 | Regression — `listAdapterIds()` + prior sources | ✅ PASS | `listAdapterIds()` → `['detik', 'viva', 'suara', 'cnn_indonesia', 'liputan6', 'tirto']` — all 6 present. Went further than "optionally quick fixture crawl:once for one prior source": ran `npm run crawl:once --limit=1` for **all 5** prior sources (`detik`, `viva`, `suara`, `cnn_indonesia`, `liputan6`) against the same live DB — all `stored (new_article)` with no errors. Final row-count check (`SELECT source_id, COUNT(*) FROM articles GROUP BY source_id`) shows **exactly 1 row per source, for all 6 sources**. The `sources` table also shows all 6 rows with distinct `adapter_version` values (`detik_v1_live`, `viva_v1_1`, `suara_v1`, `cnn_indonesia_v1`, `liputan6_v1`, `tirto_v1`). No adapter, core, or db source file was modified during this QA pass. |
| 7 | Tirto specifics coherence (flat URL, no multipage, published_at/tags) | ✅ PASS | **Flat URL pattern**: `isArticleUrl()` correctly requires exactly one path segment matching `ARTICLE_SLUG_PATTERN` (3+ hyphen tokens + trailing 4-char code) and rejects the documented section-root collisions (`/bisnis-tirto`, `/visual-tirto`, `/rilis-pers`, `/pikir-dua-kali`) via `NON_ARTICLE_ROOT_SLUGS` — all confirmed live in the smoke test. **No multipage merge**: confirmed no `pages_merged`/`[data-page]` logic exists anywhere in `src/adapters/tirto/**` (grep clean) — `parse()` reads a single fixture document and `stripPageParam()` is applied defensively only, matching the documented "no live multipage markup found" design. **published_at/tags**: fixture is purpose-built to prove `published_at` (DOM "Terbit" byline, 11:00) and `updated_at_source` (`article:modified_time` meta, 14:12) are tracked as genuinely different values (not conflated) — confirmed distinct in `parse()` output; `tags` extraction correctly filters out breadcrumb/taxonomy-label restatements from `meta[name="news_keywords"]` while keeping real topical keywords — confirmed coherent by reading `fixtures/tirto/sample-article.html` against `extractTags()`'s logic and the smoke test's own assertions. |
| 8 | Live safety | ✅ PASS (spot-check) | `CRAWL_LIVE` was never set to `true` at any point in this gate — every `crawl:once`/smoke-test invocation ran with it unset (`.env`'s `CRAWL_LIVE=false`, confirmed unchanged before/after). Spot-checked the fail-fast code path directly (not exercised live): `src/core/crawlLimit.js`'s `resolveDiscoverLimit({ liveCrawl: true })` with no limit throws `"CRAWL_LIVE=true requires an explicit crawl limit..."` as expected. `src/workers/lib/fetchHtml.js`'s `FIXTURE_PATHS` includes an entry for `tirto` (fixture-first by default, live only opt-in via `CRAWL_LIVE=true`), same convention as all 5 prior sources. |

## GO criteria re-check

- **Tirto satisfies the core adapter contract** — yes, `assertAdapterShape` PASS, registered correctly in `src/adapters/index.js` and `src/workers/lib/fetchHtml.js`'s `FIXTURE_PATHS`.
- **Fixture path fully green (discover → parse → store → idempotent re-run)** — yes, verified live end-to-end against a real (disposable) Postgres instance, not just statically read.
- **N5 contract respected (snake_case, required fields)** — yes, zero camelCase leakage, all hard-required fields present in the fixture output.
- **Tirto's defining characteristics (flat URL shape, no multipage, published_at vs. updated_at_source distinction, tag filtering) all behave as documented** — yes, confirmed via smoke test + direct fixture/logic inspection.
- **No regression on detik/suara/viva/cnn_indonesia/liputan6** — yes, all 5 still load, pass `assertAdapterShape`, and store successfully via `crawl:once`; final row counts confirm exactly 1 row per source for all 6 sources.
- **No live network crawl performed in this gate** — yes, `CRAWL_LIVE` stayed unset (`false`) throughout; fail-fast code path spot-checked only, in isolation, without actually enabling live mode.

All criteria met → **GO**.

## DB environment note (not a blocker, but worth flagging — same pattern as S3-E)

- The `.env` checked into this workspace has `DATABASE_URL=postgresql://egi:egi@localhost:5434/egi_crawl`. At the start of this gate, port **5434** had nothing listening on it (the disposable container S3-E created for `docs/SPRINT3_QA.md` had already been removed after that gate, per its own documented cleanup step — this is expected, not a new issue). The only currently-running Postgres containers on this host are `egi-postgres` (port 5433 — the **editorial EGI app database**, must not be touched/reused for crawler QA, per this task's explicit instruction) and two unrelated project containers (`makka-hotel-db-1` on 5432 internal, `orviko-postgres` on 5432).
- Per this task's instruction, I provisioned a fresh disposable container (`egi_crawl_s3b_qa`, `postgres:16-alpine`, port **5434** — deliberately reusing the same port the checked-in `.env` already pointed at, so no `.env` edit was needed at all — db `egi_crawl`, user/pass `egi`/`egi`, same convention as `docs/DB_VERIFY_REPORT.md` and `docs/SPRINT3_QA.md`), ran `npm run migrate` against it (both migrations applied cleanly), ran every DB-touching check above for real, and then **removed the container** (`docker rm -f egi_crawl_s3b_qa`) when done. `.env` itself was never edited during this pass — it already had the right host/port for a disposable container's convention.
- **Residual (carried forward, unchanged from S3-E):** `.env`'s `DATABASE_URL` in this workspace still reads `...@localhost:5434/egi_crawl`, which no longer exists (container removed after this QA pass, same disposable-cleanup convention as every prior gate). Whoever next needs a live DB for this repo should recreate it, e.g.:

  ```bash
  docker run --name egi_crawl_dev -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
  npm run migrate
  ```

  This is an environment/local-config issue, not an adapter or pipeline defect — it does not affect this gate's verdict since the DB path was fully exercised against a working (temporary) instance for every store/idempotency check.

## Residuals / follow-ups (non-blocking)

1. **`.env`'s `DATABASE_URL` port drift** — see "DB environment note" above; carried forward from S3-E, environment/config hygiene issue only, not an adapter defect.
2. **Tirto `tags` sourced from `meta[name="news_keywords"]` with heuristic breadcrumb/stopword filtering.** Documented as low–medium confidence in the adapter's own field matrix (`src/adapters/tirto/coreAdapter.js`) — same accepted gap pattern as Liputan6's `meta:keywords` and VIVA's tag handling from prior sprints. Not a defect, just carried forward for visibility.
3. **Tirto `author_name` can be institutional/brand-only** (e.g. "Tim Riset Tirto" on fact-check pieces). Documented and accepted by design in the field matrix, same stance already accepted for CNN Indonesia/detik/VIVA's brand-only bylines.
4. **Tirto `category` has no URL-segment fallback** (article URLs are flat, no `{channel}` path segment) — relies solely on breadcrumb DOM. Documented as medium confidence; not exercised beyond the single fixture sample in this gate, but the extraction logic itself is straightforward and low-risk.

## How I verified (commands)

```bash
# Adapter shape + registry regression (all 6 sources)
node -e "const { getAdapter, listAdapterIds } = require('./src/adapters'); \
  const { assertAdapterShape } = require('./src/core/adapterContract'); \
  console.log(listAdapterIds()); \
  for (const id of listAdapterIds()) assertAdapterShape(getAdapter(id));"

# Fixture smoke test (offline, no CRAWL_LIVE)
node fixtures/tirto/smoke-test.js

# N5 snake_case scan (ad hoc probe, not committed)
node -e "const coreAdapter = require('./src/adapters/tirto/coreAdapter'); \
  coreAdapter.parse(undefined, { url: 'https://tirto.id/contoh-judul-berita-tirto-pertama-hzAA' }) \
    .then((a) => console.log(Object.keys(a).filter((k) => /[a-z0-9]([A-Z])/.test(k))));"

# Disposable local Postgres for the store/idempotency checks (reuses .env's existing port,
# so no .env edit needed)
docker run --name egi_crawl_s3b_qa -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
npm run migrate

# crawl:once fixture path for tirto, run 1 (stored) and run 2 (duplicate)
npm run crawl:once -- --source=tirto --limit=1   # x2

# Regression: prior 5 sources still store successfully
npm run crawl:once -- --source=detik --limit=1
npm run crawl:once -- --source=viva --limit=1
npm run crawl:once -- --source=suara --limit=1
npm run crawl:once -- --source=cnn_indonesia --limit=1
npm run crawl:once -- --source=liputan6 --limit=1

# Row-count / idempotency confirmation (all 6 sources)
docker exec egi_crawl_s3b_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, COUNT(*) FROM articles GROUP BY source_id ORDER BY source_id;"
docker exec egi_crawl_s3b_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, display_name, adapter_version FROM sources ORDER BY source_id;"

# Live-safety fail-fast spot-check (isolated, CRAWL_LIVE never actually set)
node -e "const { resolveDiscoverLimit } = require('./src/core'); \
  try { resolveDiscoverLimit({ explicitLimit: undefined, liveCrawl: true }); } \
  catch (e) { console.log('fail-fast OK:', e.message); }"

# Cleanup
docker rm -f egi_crawl_s3b_qa
```

No adapter, core, or db source file was modified during this QA pass. `.env` was read but never
edited (its existing `DATABASE_URL` port happened to already match the disposable container
convention). The only artifact of this gate is this report.
