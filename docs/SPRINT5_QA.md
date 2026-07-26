# Sprint 5 QA — S5-E Quality Gate

**Verdict: GO**

**Scope:** Verify Okezone (S5-A) and SINDOnews (S5-B) are production-ready for Sprint 5's
multi-subdomain batch, and that S5-D's registry wiring didn't break the existing 9 adapters
(detik/viva/suara/cnn_indonesia/liputan6/tirto/tempo/kumparan/jawa_pos). Fixture-only checks
throughout — `CRAWL_LIVE` was never set to `true` in this pass. This sprint's focus is
qualitatively different from prior gates: both new sources are genuinely **multi-subdomain,
one-`source_id`** brands (every "kanal"/vertical lives on its own `{kanal}.<brand>.com` host),
so the bulk of this report is the multi-subdomain-specific gates (#8–#12) rather than the
standard per-source checklist, which both sources pass cleanly.

Postgres was unavailable at the `DATABASE_URL` value already present in the local `.env`
(residual left by S4-E, same recurring pattern as every prior gate — see "DB environment note"
below); a disposable local container was provisioned for this gate so the store/upsert/
idempotency checks could run for real instead of being skipped, then removed when done.

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `assertAdapterShape` passes for `okezone`, `sindonews` (+ prior 9 still pass) | ✅ PASS | A live `node -e` probe called `listAdapterIds()` → all **11** ids present (`['detik','viva','suara','cnn_indonesia','liputan6','tirto','tempo','kumparan','jawa_pos','okezone','sindonews']`), then ran `assertAdapterShape(getAdapter(id))` for every one — all 11 passed (`discover`/`parse`/`isArticleUrl` all present as functions, `getSourceProfile` too). No regression on the prior 9. |
| 2 | Fixture smoke: `node fixtures/{okezone,sindonews}/smoke-test.js` (`CRAWL_LIVE` unset) | ✅ PASS | Both exit 0 and print `[<source> smoke] OK`. **Okezone**: `discover()` returns 6 candidates spanning `news.okezone.com` (kanal indeks fixture) + `bola.okezone.com` (index.okezone.com bydate-channel fixture) — 2 distinct discovery channels, 2 distinct kanal hosts, every item carries `external_id`+`published_hint`. `isArticleUrl()` matrix (14 cases) all pass, including 3 kanal hosts returning `true` and sibling-brand/asset/non-article-path cases returning `false`. `parse()` on the `news.okezone.com` multipage fixture yields `content_text` merged via `?page=all` (`pages_detected: 2`, `merged_via_page_all: true`), page-2-only content present, `Baca Juga`/embedded-video noise stripped; a second `parse()` on the `bola.okezone.com` single-page fixture confirms the 3rd kanal (`Sepakbola Dunia` category) also works. **SINDOnews**: `discover()` returns 5 candidates spanning 5 distinct kanal hosts (`ekbis`/`international`/`nasional`/`sports`/`kalam`) from one fixture listing. `isArticleUrl()` matrix (5 true-cases incl. pagination-suffix and `?showpage=all` variants, 11 false-cases incl. asset hosts/out-of-scope MNC products/sibling brands/listing pages) all pass. `external_id` dedupe cross-kanal check passes (`1731775` for both a URL on `ekbis.` and a hypothetical republish on `international.`), and the pagination-path-segment trap (`/5` suffix) is proven NOT to leak into `external_id`. `parse()` merges the bundled `?showpage=all` fixture (`used_showpage_all: true`, page-2-only paragraph present, `Baca Juga`/`.editor`/embedded-video noise stripped) and a dedicated single-page-fallback check (`fetchShowpageAll` forced to return `undefined`) confirms graceful degradation to page-1-only content still works. |
| 3 | N5 snake_case — zero camelCase keys, required fields present | ✅ PASS | Called `coreAdapter.parse()` directly for both and regex-scanned the returned object's keys (`/[a-z0-9]([A-Z])/`) — **zero** camelCase keys for each (15 keys: `external_article_id`, `canonical_url`, `title`, `summary`, `content_text`, `content_html`, `author_name`, `category`, `tags`, `thumbnail_url`, `published_at`, `updated_at_source`, `language`, `parser_version`, `field_provenance` — identical shape to every prior sprint's adapters). `canonical_url`, `title`, `content_text` all present and non-empty for both. `adapter_version` present via each `getSourceProfile()` (`okezone_v1`, `sindonews_v1`) and mirrored onto `parser_version` on the parsed article — confirmed both in the direct probe and in the `sources`/`articles` tables after `crawl:once`. |
| 4 | `crawl:once` fixture path for okezone/sindonews | ✅ PASS | `npm run crawl:once -- --source=<id> --limit=1` for both → `stored (new_article)`, against a real (disposable, local) Postgres instance — `upsertArticle`/`storeParsedArticle` executed for real. `CRAWL_LIVE` left unset throughout. |
| 5 | Idempotent re-run | ✅ PASS | Ran the same `crawl:once` command a 2nd time for both → `duplicate (duplicate_content)` for each. Verified directly in Postgres: `SELECT source_id, COUNT(*) FROM articles GROUP BY source_id` → **exactly 1 row** for `okezone` and `sindonews` after 2 runs each. Same dedup mechanism (`content_hash` + `articles_source_id_canonical_url_key` UNIQUE constraint) already proven for every prior source. |
| 6 | Regression — `listAdapterIds()` + prior sources | ✅ PASS | `listAdapterIds()` → all **11** ids present (see check 1). Spot-checked 2 of the 9 prior sources via `crawl:once --limit=1` against the same live DB: `tirto` and `detik` both → `stored (new_article)` with no errors. Final row-count check shows **exactly 1 row per source** for all 4 sources queried (`detik`, `okezone`, `sindonews`, `tirto`); `sources` table shows all 4 rows with distinct `adapter_version` values. No adapter, core, or db source file was modified during this QA pass. |
| 7 | Live safety | ✅ PASS (spot-check) | `CRAWL_LIVE` was never set to `true` at any point in this gate — every smoke-test/`crawl:once` invocation ran with it unset; `.env`'s `CRAWL_LIVE=false` confirmed unchanged before and after this pass (byte-identical). Spot-checked the fail-fast code path directly (not exercised live): `resolveDiscoverLimit({ liveCrawl: true })` with no explicit limit throws `"CRAWL_LIVE=true requires an explicit crawl limit..."` as expected. Both adapters' `discover()`/`resolveFullArticleHtml()`/`resolveBodyHtml()` only perform live HTTP when `process.env.CRAWL_LIVE === 'true'` (verified by direct code read); fixture-first by default. |

## Sprint 5 focus — multi-subdomain gates (blocking if fail)

| # | Check | Result | Evidence |
|---|---|---|---|
| 8 | **`allowed_domains`: non-empty explicit allowlists (not blind `*.domain`)** | ✅ PASS | **Okezone**: `getSourceProfile().allowed_domains` = 10 explicit hosts (`news`/`sports`/`economy`/`women`/`celebrity`/`bola`/`muslim`/`edukasi`/`ototekno`.okezone.com + `index.okezone.com` for discovery) — no `*` wildcard entry anywhere (confirmed both by direct read of `ALLOWED_ARTICLE_HOSTS`/`DISCOVERY_HOST` in `index.js` and by the smoke test's own explicit assertion: `allowed_domains.some(d => d.startsWith('*'))` must be `false`). **SINDOnews**: `getSourceProfile().allowed_domains` = 11 explicit hosts (`www.sindonews.com` + 10 kanal hosts `nasional`/`daerah`/`ekbis`/`international`/`sports`/`kalam`/`edukasi`/`lifestyle`/`otomotif`/`tekno`.sindonews.com) — deliberately excludes `e.`/`pict.` (asset/CDN) and `hi-lite.`/`scope.`/`media.` (separate MNC-group products), no wildcard. Both confirmed live via the smoke tests' printed `source profile` JSON. |
| 9 | **Multi-subdomain `isArticleUrl`: true for ≥2 kanal subdomains per source** | ✅ PASS | **Okezone**: `isArticleUrl()` returns `true` for 3 distinct kanal hosts in the smoke test (`news.okezone.com`, `bola.okezone.com`, `economy.okezone.com` — the last not even present in the discovery fixtures, proving allowlist-membership alone is sufficient, not just "whatever discover() happened to return"). Ran an additional ad-hoc `discover()` probe (limit=10, no live) confirming the default discovery output itself already spans 2 kanal hosts (`news.okezone.com`, `bola.okezone.com`) by design (the adapter intentionally queries 2 independent discovery channels for this exact reason). **SINDOnews**: `isArticleUrl()` returns `true` for 3+ distinct kanal hosts in the smoke test (`ekbis.`, `international.`, `nasional.` — plus pagination-suffix and `?showpage=all` variants of the same `ekbis.` URL), and the same ad-hoc `discover()` probe shows the default discovery output spans **5** distinct kanal hosts (`ekbis`, `international`, `nasional`, `sports`, `kalam`) from one `/indeks`-style fixture listing. |
| 10 | **Sibling / asset rejection** | ✅ PASS | **Okezone** (all confirmed `false` in the smoke test's `isArticleUrl` matrix): `inews.id` (sibling MNC Media brand, different apex domain) → false; `mpi.okezone.com/article/sindonews/{id}` (real okezone.com subdomain that republishes SINDOnews content — explicitly documented by the implementer in `index.js`'s module header as the #1 reason this can't be a blind `*.okezone.com` wildcard) → false; `img.okezone.com`/`redaksi.okezone.com` (asset/author-profile hosts) → false; `/more/` and `/mmore/` paths (robots.txt-disallowed, verified live by the implementer) → false; `sindonews.com` (sibling brand) → false. **SINDOnews** (all confirmed `false`): `e.sindonews.com`/`pict.sindonews.com` (asset/image-CDN hosts) → false; `hi-lite.sindonews.com` (a *different* MNC product that DOES have its own `/read/`-shaped URLs — explicitly documented by the implementer as needing an explicit exclusion, not just relying on path shape) → false; `scope.sindonews.com`/`media.sindonews.com` (other MNC-group products) → false; `index.sindonews.com` (301-redirect alias, never itself an article host) → false; `www.okezone.com`/`www.detik.com` (sibling/unrelated brands) → false; `www.sindonews.com/indeks`, `/topic/`, `/blog/` (listing/utility pages on an in-scope host) → false. |
| 11 | **`external_id` dedupe** | ✅ PASS | **Okezone**: `extractExternalId()` recovers the `{articleId}` path segment (2nd-to-last, e.g. `9100001`) on every fixture-parsed article — confirmed both via the smoke test's own assertion (`external_article_id !== '9100001'` would throw) and via this gate's independent `crawl:once` run, which stored the article with `external_article_id` correctly populated. **SINDOnews**: same `/read/{id}/` numeric id across **two different kanal subdomains** (`ekbis.sindonews.com/read/1731775/...` and a hypothetical republish at `international.sindonews.com/read/1731775/...`) both resolve to the identical `external_id` = `"1731775"` (verified directly via `rawSindonews.extractExternalId()` in the smoke test, independently re-run in this gate's probe) — proving the documented "primary dedupe key across kanal/subdomains" claim. The pagination-path-segment trap (`/read/{id}/{subId}/{slug}/5` — a page offset, NOT a second id, per the task brief's explicit warning) was also verified to NOT leak into `external_id` (`.../5` still yields `"1731775"`, not `"5"`). |
| 12 | **Discover offline does not emit out-of-allowlist hosts** | ✅ PASS | Ran `discover({ limit: 10 })` for both adapters (CRAWL_LIVE unset) and cross-checked every returned item's URL hostname against that adapter's own `getSourceProfile().allowed_domains` set. **Okezone**: discovered hosts `{news.okezone.com, bola.okezone.com}` — 0 out-of-allowlist. **SINDOnews**: discovered hosts `{ekbis, international, nasional, sports, kalam}.sindonews.com` — 0 out-of-allowlist. No asset host, sibling brand, or excluded MNC-group product ever appears in either adapter's fixture-mode discovery output. |

## GO criteria re-check

- **Okezone and SINDOnews each satisfy the core adapter contract** — yes, `assertAdapterShape` PASS for both, correctly registered in `src/adapters/index.js` (11 total ids, verified via `listAdapterIds()`).
- **Fixture path fully green (discover → parse → store → idempotent re-run) for both** — yes, verified live end-to-end against a real (disposable) Postgres instance, not just statically read.
- **N5 contract respected (snake_case, required fields)** — yes, zero camelCase leakage for both, all hard-required fields (`canonical_url`, `title`, `content_text`) present and non-empty; `adapter_version` correctly surfaced via each `getSourceProfile()`.
- **Multi-subdomain gates (#8–#12), the Sprint 5-specific blocking criteria, all pass**: both sources ship genuine explicit host allowlists (no wildcards), `isArticleUrl()` correctly spans ≥2 (in practice 3 and 5, respectively) kanal subdomains, sibling-brand/asset-host/out-of-scope-product rejection is comprehensive and explicitly documented per host, `external_id` dedupe is proven cross-kanal for SINDOnews and present-on-parse for Okezone, and offline `discover()` never emits a host outside its own allowlist for either source.
- **No regression on the 9 prior sources** — yes; registry still resolves and shape-validates all 9, and 2 of them (`tirto`, `detik`) were spot-checked live via `crawl:once` and store successfully.
- **No live network crawl performed in this gate** — yes, `CRAWL_LIVE` stayed unset (`false`) throughout, confirmed unchanged in `.env` before/after; fail-fast code path spot-checked only, in isolation, without actually enabling live mode.

All criteria met → **GO**.

## DB environment note (not a blocker, but worth flagging — same pattern as every prior gate)

- The `.env` checked into this workspace has `DATABASE_URL=postgresql://egi:egi@localhost:5434/egi_crawl`. At the start of this gate, port **5434** had nothing listening on it (the disposable container S4-E created for `docs/SPRINT4_QA.md` had already been removed after that gate, per its own documented cleanup step — expected, not a new issue). The only currently-running Postgres containers on this host at the time of this gate were `egi-postgres` (port 5433 — the **editorial EGI app database**, deliberately not touched/reused for crawler QA, per this task's explicit instruction), `makka-hotel-db-1` (internal 5432, unrelated project), and `orviko-postgres` (port 5432, unrelated project).
- Per this task's instruction, a fresh disposable container was provisioned (`egi_crawl_s5_qa`, `postgres:16-alpine`, port **5434** — deliberately reusing the same port the checked-in `.env` already pointed at, so no `.env` edit was needed at all — db `egi_crawl`, user/pass `egi`/`egi`, same convention as every prior gate's report), `npm run migrate` was run against it (both migrations applied cleanly), every DB-touching check above ran for real against it, and then the **container was removed** (`docker rm -f egi_crawl_s5_qa`) when done. `.env` itself was never edited during this pass.
- **Residual (carried forward, unchanged since S3-E):** `.env`'s `DATABASE_URL` in this workspace still reads `...@localhost:5434/egi_crawl`, which no longer exists (container removed after this QA pass, same disposable-cleanup convention as every prior gate). Whoever next needs a live DB for this repo should recreate it, e.g.:

  ```bash
  docker run --name egi_crawl_dev -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
  npm run migrate
  ```

  This is an environment/local-config issue, not an adapter or pipeline defect — it does not affect this gate's verdict since the DB path was fully exercised against a working (temporary) instance for every store/idempotency check.

## Residuals / follow-ups (non-blocking, carried from implementers + this gate)

1. **`.env`'s `DATABASE_URL` port drift** — see "DB environment note" above; carried forward from every prior gate since S3-E, environment/config hygiene issue only, not an adapter defect.
2. **Okezone: `mpi.okezone.com` cross-brand republish host is excluded by construction, not detected content-wise.** The adapter's own module header documents this candidly: `mpi.okezone.com` is a real `okezone.com` subdomain (verified live) that republishes SINDOnews content under `/article/sindonews/{id}` — a *different* path shape than `ARTICLE_PATH_PATTERN`'s `/read/{y}/{m}/{d}/{sectionId}/{articleId}/{slug}` anyway, so even if it were accidentally allowlisted it likely wouldn't match `isArticleUrl()`'s path pattern either. The explicit host allowlist is the primary defense (verified: `mpi.okezone.com` is simply absent from `ALLOWED_ARTICLE_HOSTS`), and this gate confirms it resolves to `false`. Non-blocking — documented, not a bug.
3. **SINDOnews: `www.sindonews.com` allowlisted as a first-class article host despite no live-observed article actually being served directly from `www`.** The implementer documents this in the module header as a deliberate per-task-brief inclusion ("allowed_domains: allowlist of news kanal hosts + www.sindonews.com") rather than a live-verified necessity. Low risk: `isArticleUrl()` still requires the `/read/{id}/{subId}/{slug}` path shape on that host, so this doesn't widen scope to non-article `www` pages (confirmed: `www.sindonews.com/indeks`, `/topic/`, `/blog/` all correctly return `false`).
4. **SINDOnews: live `/indeks` discovery and the live `?showpage=all` fetch are both fixture-first by design, not independently verified against a fresh live capture in this gate** (this gate only exercised offline/fixture mode, per task's out-of-scope instruction "No live network crawls"). The implementer's module header documents these as verified live as of 2026-07-24 at authoring time; re-verification before `CRAWL_LIVE=true` is ever flipped for this source is recommended but out of scope for this QA pass.
5. **Okezone: `updated_at_source` (JSON-LD `dateModified`) and SINDOnews's own equivalent both assume `WIB` (+07:00) for no-timezone-marker date strings** — same "no-tz means WIB" convention already accepted for CNN Indonesia/Tempo/Jawa Pos in prior gates, re-confirmed still applied consistently here. Not a new risk.
6. **No 3rd-party/independent verification of the live-site structural claims in either adapter's module header** (e.g. Okezone's `/indeks` offset-10 pagination step, SINDOnews's offset-20 step, the exact `{channelId}`/`{cid}` values) — this gate is fixture-path QA only, per its explicit scope; these claims are taken on the strength of the implementers' documented live-verification notes and are not independently re-crawled here.

## How I verified (commands)

```bash
# Adapter shape + registry regression (all 11 sources)
node -e "const { getAdapter, listAdapterIds } = require('./src/adapters'); \
  const { assertAdapterShape } = require('./src/core/adapterContract'); \
  const ids = listAdapterIds(); console.log('ids:', ids, ids.length); \
  for (const id of ids) { assertAdapterShape(getAdapter(id)); console.log(id, 'OK'); }"

# Fixture smoke tests (offline, no CRAWL_LIVE)
node fixtures/okezone/smoke-test.js
node fixtures/sindonews/smoke-test.js

# N5 snake_case scan (ad hoc probe, not committed) — okezone/sindonews
node -e "/* see report body: parses each coreAdapter directly, regex-scans keys for camelCase */"

# Multi-subdomain gate #12: discover() never emits an out-of-allowlist host
node -e "/* see report body: discover({limit:10}) hostnames cross-checked against
  getSourceProfile().allowed_domains for both okezone and sindonews */"

# Disposable local Postgres for the store/idempotency checks (reuses .env's existing port,
# so no .env edit needed)
docker run --name egi_crawl_s5_qa -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
npm run migrate

# crawl:once fixture path for okezone/sindonews, run 1 (stored) and run 2 (duplicate)
npm run crawl:once -- --source=okezone --limit=1     # x2
npm run crawl:once -- --source=sindonews --limit=1   # x2

# Regression spot-check: 2 of the 9 prior sources still store successfully
npm run crawl:once -- --source=tirto --limit=1
npm run crawl:once -- --source=detik --limit=1

# Row-count / idempotency confirmation
docker exec egi_crawl_s5_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, COUNT(*) FROM articles GROUP BY source_id ORDER BY source_id;"
docker exec egi_crawl_s5_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, display_name, adapter_version FROM sources ORDER BY source_id;"

# Live-safety fail-fast spot-check (isolated, CRAWL_LIVE never actually set)
node -e "const { resolveDiscoverLimit } = require('./src/core'); \
  try { resolveDiscoverLimit({ explicitLimit: undefined, liveCrawl: true }); } \
  catch (e) { console.log('fail-fast OK:', e.message); }"

# Cleanup
docker rm -f egi_crawl_s5_qa
```

No adapter, core, or db source file was modified during this QA pass. `.env` was read but never
edited (its existing `DATABASE_URL` port happened to already match the disposable container
convention). The only artifact of this gate is this report.

---

## GO
Okezone and SINDOnews both pass adapter-shape, N5 snake_case, fixture smoke, and live-DB store/idempotency checks, and — critically for Sprint 5's multi-subdomain scope — both ship explicit (non-wildcard) host allowlists, correctly accept ≥2 kanal subdomains per source while rejecting every documented sibling-brand/asset/out-of-scope host, and correctly dedupe by `external_id` across kanal subdomains, with no regression on the 9 prior sources.
