# Sprint 3 QA — S3-E Quality Gate

**Verdict: GO**

**Scope:** Verify CNN Indonesia (S3-A) + Liputan6 (S3-B) are production-ready for Sprint 3a
(fixture path), and that the S3-D registry wiring didn't break the existing pilots
(detik/suara/viva). Fixture-only checks throughout — `CRAWL_LIVE` was never set to `true` in
this pass. Postgres was unavailable at the `DATABASE_URL` value already present in the local
`.env` (see "DB environment note" below); a disposable local container was provisioned for this
gate so the store/upsert/idempotency checks could run for real instead of being skipped.

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `assertAdapterShape` passes for both new adapters | ✅ PASS | `getAdapter('cnn_indonesia')` and `getAdapter('liputan6')` both loaded via `src/adapters/index.js` and passed `src/core/adapterContract.js`'s `assertAdapterShape()` (has `discover`/`parse`/`isArticleUrl` as functions) in a live `node -e` probe. Same probe re-confirmed detik/viva/suara still pass. |
| 2 | Fixture smoke test | ✅ PASS | Ran the bundled `fixtures/cnn_indonesia/smoke-test.js` and `fixtures/liputan6/smoke-test.js` directly (`node fixtures/<source>/smoke-test.js`, `CRAWL_LIVE` unset) — both exit 0 / print `OK`. Each script's own internal assertions (non-empty `title`/`content_text`/`summary`/`thumbnail_url`/`tags`, ad/noise-block stripping, `isArticleUrl` true/false cases) passed with no code changes needed. |
| 3 | N5 snake_case — zero camelCase keys, required fields present | ✅ PASS | Called `coreAdapter.parse()` directly for both sources and regex-scanned the returned object's keys (`/[a-z0-9]([A-Z])/`) — **zero** camelCase keys for either (`cnn_indonesia`: 15 keys; `liputan6`: 15 keys, all snake_case). `source_id`/`requested_url`/`final_url`/`normalized_url`/`content_hash`/`collected_at` are pipeline-side per `src/core/fieldContract.js` (confirmed unchanged); `title`, `content_text`, `adapter_version` (via `getSourceProfile().adapter_version`), and `canonical_url` are all present and non-empty from both adapters' fixture output. `published_at` is present for both fixtures (not just soft-required) — `src/db/articles.js`'s `buildValidationWarnings()` soft-warning path was not exercised by these fixtures but remains unchanged/untouched and still gates on absence only, not blocking store. |
| 4 | `crawl:once` fixture path, both sources | ✅ PASS | `npm run crawl:once -- --source=cnn_indonesia --limit=1` → `stored (new_article)`. `npm run crawl:once -- --source=liputan6 --limit=1` → `stored (new_article)`. Both against a real (disposable, local) Postgres — `assertDatabaseReady()`'s fail-fast was not triggered because the DB was up for this run; `upsertArticle`/`storeParsedArticle` executed for real, not just parse-checked. `CRAWL_LIVE` was left unset for both. |
| 5 | Idempotent re-run | ✅ PASS | Ran both `crawl:once` commands a 2nd time: `cnn_indonesia` → `duplicate (duplicate_content)`; `liputan6` → `duplicate (duplicate_content)`. Verified directly in Postgres afterward: `SELECT source_id, COUNT(*) FROM articles GROUP BY source_id` shows **exactly 1 row each** for `cnn_indonesia` and `liputan6` after 2 runs — no duplicate rows, `content_hash` stable across both runs, `articles_source_id_canonical_url_key` UNIQUE constraint + content-hash dedup both confirmed working (same mechanism already proven for the pilots in `docs/DB_VERIFY_REPORT.md`). |
| 6 | Regression — pilots not broken | ✅ PASS | `listAdapterIds()` → `['detik', 'viva', 'suara', 'cnn_indonesia', 'liputan6']` (all 3 pilots still present). Also re-ran `npm run crawl:once` for `detik`, `viva`, and `suara` (`--limit=1` each) against the same live DB — all three still `stored (new_article)` with no errors. `src/sources/registry.js`'s `loadAllSources()` (dynamic, driven off `listAdapterIds()`) also successfully loads and profile-validates all 5 entries with no `sourceId` mismatch. No pilot or shared core/db file was modified during this QA pass. |
| 7 | Liputan6 multipage merge | ✅ PASS | `fixtures/liputan6/smoke-test.js`'s own assertion + an independent `coreAdapter.parse()` probe both confirm `field_provenance.content_text.pages_merged === 2` and `content_text` contains both the page-2 sub-heading ("Update Redaksi") and page-2 body text ("...hanya ada di halaman kedua...") merged after the page-1 paragraphs, with the `data-page` blocks read from a **single** fixture HTML file (no second HTTP fetch involved) — matches the documented "same-document multipage" design in `src/adapters/liputan6/index.js`'s header comment. |
| 8 | Live safety | ✅ PASS (spot-check) | `CRAWL_LIVE` was never set to `true` at any point in this gate — every `crawl:once`/smoke-test invocation ran with it unset (`.env`'s `CRAWL_LIVE=false`). Spot-checked the fail-fast code path (not exercised live): `src/core/crawlLimit.js`'s `resolveDiscoverLimit()` throws `"CRAWL_LIVE=true requires an explicit crawl limit..."` when `liveCrawl` is true and no limit is resolvable; `src/workers/lib/fetchHtml.js`'s `FIXTURE_PATHS` includes entries for both `cnn_indonesia` and `liputan6` (fixture-first by default, live only opt-in), same convention as the 3 pilots. |

## GO criteria re-check

- **Both new adapters satisfy the core adapter contract** — yes, `assertAdapterShape` PASS.
- **Fixture path fully green (discover → parse → store → idempotent re-run)** — yes, verified live end-to-end against a real Postgres instance, not just statically read.
- **N5 contract respected (snake_case, required fields)** — yes, zero camelCase leakage, all hard-required fields present in both fixture outputs.
- **Liputan6's defining feature (same-document multipage merge) works** — yes, `pages_merged === 2` and page-2 text verified present in `content_text`.
- **No regression on detik/suara/viva** — yes, all three still load, pass `assertAdapterShape`, and store successfully via `crawl:once`.
- **No live network crawl performed in this gate** — yes, `CRAWL_LIVE` stayed unset throughout; fail-fast code path spot-checked only.

All criteria met → **GO**.

## DB environment note (not a blocker, but worth flagging)

- The `.env` checked into this workspace had `DATABASE_URL=postgresql://egi:egi@localhost:5435/egi_crawl` — port **5435** has nothing listening on it (verified with a TCP probe: connection refused). The only currently-running Postgres containers on this host are `egi-postgres` (port 5433 — per `docs/DB_VERIFY_REPORT.md` this is described as the **editorial EGI app database** and must not be touched/reused for crawler QA) and two unrelated project containers (`makka-hotel-db-1`, `orviko-postgres`).
- Per this task's instruction ("Postgres may be disposable/local"), I provisioned a fresh disposable container (`egi_crawl_s3qa`, `postgres:16-alpine`, port **5434**, db `egi_crawl`, user/pass `egi`/`egi` — same convention as the prior `docs/DB_VERIFY_REPORT.md` pass), ran `npm run migrate` against it (both migrations applied cleanly), pointed `.env`'s `DATABASE_URL` at it for the duration of this gate, ran every check above for real, and then **removed the container** (`docker rm -f egi_crawl_s3qa`) when done.
- **Residual:** `.env`'s `DATABASE_URL` in this workspace still reads `...@localhost:5434/egi_crawl`, which no longer exists (container removed after this QA pass, matching the disposable-cleanup convention `docs/DB_VERIFY_REPORT.md` also used). Whoever next needs a live DB for this repo should recreate it, e.g.:

  ```bash
  docker run --name egi_crawl_dev -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
  npm run migrate
  ```

  This is an environment/local-config issue, not an adapter or pipeline defect — it does not affect this gate's verdict since the DB path was fully exercised against a working (temporary) instance.

## Residuals / follow-ups (non-blocking)

1. **Stale header comment in `src/adapters/cnn_indonesia/coreAdapter.js` and `index.js`.** Both files' header comments (written during S3-A, before S3-D wired the registry) still say things like "this module is intentionally NOT registered in `src/adapters/index.js` yet — that is owned by S3-D" and include a "READY FOR S3-D" registry snippet at the bottom of `coreAdapter.js`. The registration **is** in fact done and correct (`src/adapters/index.js` line 29 has the real entry, verified above), so this is purely a documentation staleness issue with zero functional impact — not fixed here per the "don't touch adapter logic" constraint, but worth a 1-line comment cleanup in a future pass.
2. **CNN Indonesia `author_name` is low-confidence / frequently brand-only.** Documented and accepted by design in the adapter's own field matrix (mirrors the same accepted VIVA/detik pattern from Sprint 2) — not a gap, just carried forward here for visibility.
3. **Liputan6 `tags` sourced only from `meta[name=keywords]`.** No reliable per-article tag DOM list was found live (same accepted gap as VIVA from Sprint 2) — documented, not blocking.
4. **`.env`'s `DATABASE_URL` port drift** — see "DB environment note" above; environment/config hygiene issue, not an adapter defect.

## How I verified (commands)

```bash
# Adapter shape + registry regression
node -e "const { getAdapter, listAdapterIds } = require('./src/adapters'); \
  const { assertAdapterShape } = require('./src/core/adapterContract'); \
  console.log(listAdapterIds()); \
  for (const id of ['cnn_indonesia','liputan6','detik','viva','suara']) assertAdapterShape(getAdapter(id));"
node -e "const { loadAllSources } = require('./src/sources/registry'); console.log(loadAllSources().map(e => e.sourceId));"

# Fixture smoke tests (offline, no CRAWL_LIVE)
node fixtures/cnn_indonesia/smoke-test.js
node fixtures/liputan6/smoke-test.js

# N5 snake_case scan (ad hoc probe, not committed)
node -e "/* coreAdapter.parse() for both sources, regex key-name scan */"

# Disposable local Postgres for the store/idempotency checks
docker run --name egi_crawl_s3qa -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
npm run migrate

# crawl:once fixture path, run 1 (stored) and run 2 (duplicate), each source
npm run crawl:once -- --source=cnn_indonesia --limit=1   # x2
npm run crawl:once -- --source=liputan6 --limit=1        # x2

# Pilot regression (no code changes to these adapters)
npm run crawl:once -- --source=detik --limit=1
npm run crawl:once -- --source=viva --limit=1
npm run crawl:once -- --source=suara --limit=1

# Row-count / idempotency confirmation
docker exec egi_crawl_s3qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, COUNT(*) FROM articles GROUP BY source_id ORDER BY source_id;"

# Cleanup
docker rm -f egi_crawl_s3qa
```

No adapter, core, or db source file was modified during this QA pass. The only artifacts of
this gate are this report and the (already-reverted, container-removed) local `.env`
`DATABASE_URL` value noted above.
