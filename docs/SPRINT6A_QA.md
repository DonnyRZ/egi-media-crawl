# Sprint 6a QA — S6a-E Quality Gate

**Verdict: GO**

**Scope:** Verify IDN Times (S6a-A), Republika Online (S6a-B), and Media Indonesia (S6a-C) are
production-ready for Sprint 6a (fixture path), and that S6a-D's registry wiring didn't break the
existing 11 adapters (detik/viva/suara/cnn_indonesia/liputan6/tirto/tempo/kumparan/jawa_pos/
okezone/sindonews). Fixture-only checks throughout — `CRAWL_LIVE` was never set to `true` in this
pass, and no live network crawl was performed. Postgres was unavailable at the `DATABASE_URL`
value already present in the local `.env` (residual left by S5-E, same recurring pattern as every
prior gate — see "DB environment note" below); a disposable local container was provisioned for
this gate so the store/upsert/idempotency checks could run for real instead of being skipped, then
removed when done.

This sprint's three sources ("Wave A") each carry their own documented live-site quirk that the
task brief specifically calls out for scrutiny: IDN Times' `/indeks` 404s live (discovery instead
uses a category-hub path) and ships genuine hyperlocal regional subdomains that must NOT be
swept into scope; Republika is multi-subdomain-but-one-`source_id` (like okezone/sindonews before
it) and defers per-region discovery seeds; Media Indonesia's premium/teaser detection must lower
`content_text` confidence rather than fake a full body, and its pagination is an offset PATH
segment, not a `?page=` query string. All three are addressed below in the "Wave A specifics"
section in addition to the standard per-source checklist.

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `assertAdapterShape` passes for `idn_times`, `republika`, `media_indonesia` (+ prior 11 still pass) | ✅ PASS | A live `node -e` probe called `listAdapterIds()` → all **14** ids present (`['detik','viva','suara','cnn_indonesia','liputan6','tirto','tempo','kumparan','jawa_pos','okezone','sindonews','idn_times','republika','media_indonesia']`), then ran `assertAdapterShape(getAdapter(id))` for every one — all 14 passed (`discover`/`parse`/`isArticleUrl` all present as functions, `getSourceProfile` too). No regression on the prior 11. |
| 2 | Fixture smoke: `node fixtures/{idn_times,republika,media_indonesia}/smoke-test.js` (`CRAWL_LIVE` unset) | ✅ PASS | All three exit 0 and print `[<source> smoke] OK`. **IDN Times**: `discover()` returns 3 candidates from the `listing-news.html` category-hub fixture (all under `www.idntimes.com/news/...`), every item carrying a validated `{authorCode5}-{articleCode6}` `external_id`; the smoke test itself asserts the non-article "Regional" hyperlocal promo widget (`bali.idntimes.com`) is never discovered. `isArticleUrl()` matrix (8 cases) all pass, including the hyperlocal-subdomain URL correctly returning `false` despite matching the article path shape. `parse()` on the fixture article yields 407-char `content_text` (3 DOM paragraphs, `#article-description p.article-text`), correct `published_at`/`updated_at_source` (distinct, both carrying an explicit `+07:00` from JSON-LD), the `"Update me"` junk keyword filtered out of `tags`, and a dedicated `articleBody`-fallback check (DOM paragraphs absent) confirms graceful degradation to the JSON-LD `articleBody` blob. **Republika**: `discover()` returns 3 candidates from the `indeks.html` fixture spanning 3 distinct kanal/region subdomains (`ekonomi.`, `rejabar.`, `khazanah.republika.co.id`) in one listing — proving the offline `/indeks` fixture genuinely exercises the multi-subdomain path rather than falling back to the module's hardcoded 2-item `FIXTURE_LISTING` array. `isArticleUrl()` matrix (8 cases) all pass, including the live-verified malformed double-slash `/berita//{code}/{slug}` variant → `true`, a regional (`rejabar.`) article → `true`, and the `static.republika.co.id` asset host / `/indeks` listing / `/kanal/` nav / out-of-scope `detik.com` → `false`. `parse()` yields 530-char `content_text` with "Baca Juga"/figcaption/footnote noise stripped, correct `author_name` ("Contoh Redaktur", the JSON-LD "Red:" editor byline per the documented caveat), and `category` "Energi" (last non-"Home" breadcrumb item); unit-level checks on `extractSitemapArticleUrls()`/`extractRssItems()`/`buildIndeksUrl()`/`parseListingDate()` (the secondary sitemap/RSS channels and the 3 `/index/...` URL-builder shapes) all pass. **Media Indonesia**: `discover()` merges the primary `indeks_html` (6 items) and secondary `sitemap_news` (1 item) fixture channels into 7 deduped candidates, `ctx.limit=2` honored exactly; `isArticleUrl()` matrix (10 cases) all pass, correctly excluding both the `/indeks/20/40`-shaped offset-pagination URL AND the analogous per-category `/ekonomi/20/40` variant (the numeric-2nd-segment collision risk the module header calls out), plus `/video/detail_video/...` and `/galleries/detail_galleries/...` out-of-scope content types, while accepting the `www.` host alias. `parse()` on the normal fixture yields 964-char `content_text` (in-body `<h2>` subheading kept, "Baca juga"/trailing follow-CTA stripped, trailing "(H-2)" sign-off kept as real content) with `content_text` `field_provenance` confidence `"high"`; a second `parse()` on the dedicated premium/teaser fixture (`ctx.fixtureVariant: 'premium'`) confirms the confidence-drop path (see check 8c below). |
| 3 | N5 snake_case — zero camelCase keys, required fields present | ✅ PASS | Called `coreAdapter.parse()` directly for all three and regex-scanned the returned object's keys (`/[a-z0-9]([A-Z])/`) — **zero** camelCase keys for each (15 keys: `external_article_id`, `canonical_url`, `title`, `summary`, `content_text`, `content_html`, `author_name`, `category`, `tags`, `thumbnail_url`, `published_at`, `updated_at_source`, `language`, `parser_version`, `field_provenance` — identical shape to every prior sprint's adapters). `canonical_url`, `title`, `content_text` all present and non-empty for all three (407/530/964 chars respectively). `adapter_version` present via each `getSourceProfile()` (`idn_times_v1`, `republika_v1`, `media_indonesia_v1`) and mirrored onto `parser_version` on the parsed article — confirmed both in the direct probe and in the `sources`/`articles` tables after `crawl:once`. |
| 4 | `crawl:once` fixture path for idn_times/republika/media_indonesia | ✅ PASS | `npm run crawl:once -- --source=<id> --limit=1` for all three → `stored (new_article)`, against a real (disposable, local) Postgres instance — `upsertArticle`/`storeParsedArticle` executed for real. `CRAWL_LIVE` left unset throughout. |
| 5 | Idempotent re-run | ✅ PASS | Ran the same `crawl:once` command a 2nd time for all three → `duplicate (duplicate_content)` for each. Verified directly in Postgres: `SELECT source_id, COUNT(*) FROM articles GROUP BY source_id` → **exactly 1 row** for `idn_times`, `republika`, and `media_indonesia` after 2 runs each. Same dedup mechanism (`content_hash` + `articles_source_id_canonical_url_key` UNIQUE constraint) already proven for every prior source. |
| 6 | Regression — `listAdapterIds()` + prior sources | ✅ PASS | `listAdapterIds()` → all **14** ids present (see check 1). Spot-checked 2 of the 11 prior sources via `crawl:once --limit=1` against the same live DB: `tirto` and `okezone` both → `stored (new_article)` with no errors. Final `sources` table shows 5 distinct rows queried this gate (`idn_times`, `media_indonesia`, `okezone`, `republika`, `tirto`) each with its own distinct `adapter_version`; row-count query confirms **exactly 1 row per source** for the 3 new sources. No adapter, core, or db source file was modified during this QA pass. |
| 7 | Live safety | ✅ PASS (spot-check) | `CRAWL_LIVE` was never set to `true` at any point in this gate — every smoke-test/`crawl:once` invocation ran with it unset; `.env`'s `CRAWL_LIVE=false` confirmed unchanged before and after this pass (byte-identical). Spot-checked the fail-fast code path directly (not exercised live): `resolveDiscoverLimit({ liveCrawl: true })` with no explicit limit throws `"CRAWL_LIVE=true requires an explicit crawl limit..."` as expected. All three adapters' `discover()` and `src/workers/lib/fetchHtml.js`'s `FIXTURE_PATHS` only perform live HTTP when `process.env.CRAWL_LIVE === 'true'` (verified by direct code read); fixture-first by default, and each new source's `sample-article.html` is correctly registered in `FIXTURE_PATHS`. |

## Wave A specifics (task-brief-called-out behaviors; documented, not blocking unless broken)

| # | Check | Result | Evidence |
|---|---|---|---|
| 8a | **IDN Times: discovery via category hub, not `/indeks`; hyperlocal subdomains excluded from `allowed_domains`** | ✅ PASS | `buildCategoryUrl()` (direct probe) returns `https://www.idntimes.com/news` by default and `https://www.idntimes.com/sport` when `{category: 'sport'}` is passed — **no `/indeks` path is ever constructed anywhere in `index.js`**, matching the module header's documented finding that `/indeks` 404s live on this site. `getSourceProfile().allowed_domains` (via `coreAdapter`) = `['www.idntimes.com']` — a single explicit host, NOT a `*.idntimes.com` wildcard — confirmed both by direct probe and by the smoke test's own assertion (`profile.allowed_domains.includes('www.idntimes.com')`, and separately that no discovered item's URL ever contains `bali.idntimes.com`). `isArticleUrl()` directly probed against a hyperlocal-subdomain URL (`https://bali.idntimes.com/news/indonesia/contoh-artikel-00-abcde-fghijk`, matching the article path SHAPE exactly) returns `false` solely on the host check — proving the exclusion is structural (host allowlist), not just "whatever the fixture happens to return". |
| 8b | **Republika: `/indeks` discover works offline; regional seeds deferred OK** | ✅ PASS (regional-seed deferral confirmed as documented, non-blocking) | The bundled `fixtures/republika/indeks.html` fixture parses successfully offline via `extractIndeksItems()` into 3 real discovery items spanning 3 distinct kanal/region subdomains (`ekonomi.`, `rejabar.`, `khazanah.republika.co.id`) — this is directly observably NOT the module's small hardcoded `FIXTURE_LISTING` fallback array (which only has 2 items, both without a `khazanah.` entry), so this proves the actual HTML-fixture-parsing path works end-to-end offline, not just the fallback-of-last-resort. Per the module header, dedicated per-region discovery seeds (a `rejabar.republika.co.id/indeks`-style walk) are explicitly deferred for this sprint — but regional articles are NOT excluded from scope: `isArticleUrl()` was directly probed against a `rejabar.republika.co.id/berita/...` URL and returns `true` (confirmed both via the smoke test's own assertion and this gate's independent probe), and the discovered fixture listing itself already surfaces 2 of 3 items from non-`ekonomi` regional/vertical subdomains. This is a documented scope-reduction, not a defect — the task brief explicitly calls "regional seeds deferred" acceptable for this sprint. |
| 8c | **Media Indonesia: premium fixture drops content confidence; offset-path not `?page=`** | ✅ PASS | Ran `parse()` against `fixtures/media_indonesia/sample-article-premium.html` (`ctx.fixtureVariant: 'premium'`) — returned a non-empty, short (216-char) `content_text` (never faked/padded to look like a full body) with `field_provenance.content_text` = `{"confidence":"low","note":"premium/teaser heuristic fired ..."}`, versus the normal fixture's `{"confidence":"high"}` — confirmed via both the smoke test's own assertions and this gate's direct read of the returned object. Pagination: direct probes of `buildIndeksUrl({offset:40})` → `https://mediaindonesia.com/indeks/20/40` and `buildCategoryUrl({category:'ekonomi', offset:40})` → `https://mediaindonesia.com/ekonomi/20/40` — both pure PATH-segment shapes; neither contains a `?page=` query string anywhere (explicitly checked: `.includes('?page=')` is `false` for both), matching the task brief's "offset-path not `?page=`" requirement. `isArticleUrl()` was also confirmed to correctly reject both the all-kanal and per-category offset-pagination URL shapes (`/indeks/20/40`, `/ekonomi/20/40`) as non-articles, so the offset-path scheme can never be mistaken for an article URL by the discovery/dedup layer. |

## GO criteria re-check

- **IDN Times, Republika, and Media Indonesia each satisfy the core adapter contract** — yes, `assertAdapterShape` PASS for all three, correctly registered in `src/adapters/index.js` (14 total ids, verified via `listAdapterIds()`) and in `src/workers/lib/fetchHtml.js`'s `FIXTURE_PATHS`.
- **Fixture path fully green (discover → parse → store → idempotent re-run) for all three** — yes, verified live end-to-end against a real (disposable) Postgres instance, not just statically read.
- **N5 contract respected (snake_case, required fields)** — yes, zero camelCase leakage for all three, all hard-required fields (`canonical_url`, `title`, `content_text`) present and non-empty; `adapter_version` correctly surfaced via each `getSourceProfile()`.
- **Wave A task-brief-specific behaviors verified**: IDN Times' discovery is structurally scoped to a category-hub path (never `/indeks`) with hyperlocal subdomains excluded via an explicit single-host allowlist (not a wildcard); Republika's `/indeks` fixture genuinely parses offline into a real multi-subdomain listing, and the documented "regional seeds deferred" scope reduction does not exclude regional articles from `isArticleUrl()`/discovery, just from having their own dedicated seed channel; Media Indonesia's premium/teaser heuristic correctly drops `content_text` confidence to `"low"` (never fakes a full body) and its pagination is proven to be an offset PATH segment, never a `?page=` query string.
- **No regression on the 11 prior sources** — yes; registry still resolves and shape-validates all 11, and 2 of them (`tirto`, `okezone`) were spot-checked live via `crawl:once` and store successfully.
- **No live network crawl performed in this gate** — yes, `CRAWL_LIVE` stayed unset (`false`) throughout, confirmed unchanged in `.env` before/after; fail-fast code path spot-checked only, in isolation, without actually enabling live mode.

All criteria met → **GO**.

## DB environment note (not a blocker, but worth flagging — same pattern as every prior gate)

- The `.env` checked into this workspace has `DATABASE_URL=postgresql://egi:egi@localhost:5434/egi_crawl`. At the start of this gate, port **5434** had nothing listening on it (the disposable container S5-E created for `docs/SPRINT5_QA.md` had already been removed after that gate, per its own documented cleanup step — expected, not a new issue). Per this task's explicit instruction, the editorial `egi-postgres` database (port 5433) was never touched or reused for this crawler QA pass.
- A fresh disposable container was provisioned (`egi_crawl_s6a_qa`, `postgres:16-alpine`, port **5434** — deliberately reusing the same port the checked-in `.env` already pointed at, so no `.env` edit was needed at all — db `egi_crawl`, user/pass `egi`/`egi`, same convention as every prior gate's report), `npm run migrate` was run against it (both migrations applied cleanly), every DB-touching check above ran for real against it, and then the **container was removed** (`docker rm -f egi_crawl_s6a_qa`) when done. `.env` itself was never edited during this pass (confirmed byte-identical before/after).
- **Residual (carried forward, unchanged since S3-E):** `.env`'s `DATABASE_URL` in this workspace still reads `...@localhost:5434/egi_crawl`, which no longer exists (container removed after this QA pass, same disposable-cleanup convention as every prior gate). Whoever next needs a live DB for this repo should recreate it, e.g.:

  ```bash
  docker run --name egi_crawl_dev -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
  npm run migrate
  ```

  This is an environment/local-config issue, not an adapter or pipeline defect — it does not affect this gate's verdict since the DB path was fully exercised against a working (temporary) instance for every store/idempotency check.

## Residuals / follow-ups (non-blocking, carried from implementers + this gate)

1. **`.env`'s `DATABASE_URL` port drift** — see "DB environment note" above; carried forward from every prior gate since S3-E, environment/config hygiene issue only, not an adapter defect.
2. **IDN Times: `/indeks` deep pagination and the `sitemap.xml` secondary discovery channel are both explicitly out of scope for this sprint** (per the module header: the category-hub `/news`/`/tech`/etc. path only ever surfaces one page's worth of items live, ~20-30, with no pagination attempted at all — even the `/index?page=N`-style path is deliberately avoided as robots-AMBIGUOUS). Documented as a known first-cut limitation, not a defect; `sitemap.xml` is confirmed present live per the module header but genuinely not implemented as a discovery channel.
3. **Republika: regional discovery seeds (rejabar, rejogja, etc.) are deferred, not implemented as their own channel** (see check 8b above) — regional articles still surface via the all-kanal `/indeks`/`/index/{offset}` listings and are fully parseable, but there is no dedicated per-region seed walk yet. Explicitly called out by the task brief as acceptable for this sprint.
4. **Republika: `author_name` reflects the JSON-LD "Red:" (editor) byline, not the "Rep:" (reporter) byline** — verified by the implementer on 2 live samples and re-confirmed in this gate's fixture parse (`"Contoh Redaktur"`). Documented caveat, not a bug — matches the site's own structured-data semantics.
5. **Republika: `allowed_domains` uses a `*.republika.co.id` wildcard rather than an explicit per-kanal host list** (`['republika.co.id', '*.republika.co.id']`), unlike Sprint 5's okezone/sindonews precedent of an explicit, non-wildcard allowlist. This is a deliberate implementer choice documented in both `index.js`'s and `coreAdapter.js`'s headers (Republika's kanal/region set is large and open-ended, e.g. `ameera`/`visual`/`esgnow`/`analisis`/`en` beyond the commonly-seen ones), and the task's own Wave-A checklist for Republika does not require an explicit-allowlist gate the way it implicitly did for IDN Times' hyperlocal-exclusion requirement — so this is flagged here as a stylistic divergence worth a future look, not a blocking defect for this gate. The real safety net (the `/berita/{code}/{slug}` path-shape check in `isArticleUrl()`) is unaffected either way and was independently verified in check 2/8b above.
6. **Media Indonesia: exact live DOM class names (`div.article`, `.indeks-item`, `.breadcrumb`, `.byline .author`, etc.) were NOT independently verified against raw live HTML** — the implementer's own module header candidly documents that this assessment's fetch tooling was a Markdown-rendering proxy that strips `<script>`/markup, so meta/Open Graph tags (near-universal regardless of CMS internals) were deliberately prioritized as PRIMARY signals, with these DOM selectors kept only as secondary/best-effort enhancements. Not exercised live in this gate (fixture-only, per task's explicit scope); a real limitation to keep in mind before `CRAWL_LIVE=true` is ever flipped for this source.
7. **Media Indonesia: the exact live `sitemap-news.xml` path was not independently confirmed** — the implementer's module header documents that a few plausible candidate paths all returned a proxy-reported HTTP 500 during their live assessment. `extractSitemapUrls()` is implemented against the standard Google News Sitemap schema and is exercised offline via the bundled fixture; it is a best-effort secondary channel that gracefully degrades to `[]` on any live fetch/parse failure and never blocks the primary `/indeks` channel.
8. **Media Indonesia: no live premium/teaser article sample was actually observed** during the implementer's live assessment (unlike Tempo's directly-verified `isAccessibleForFree` JSON-LD flag) — `detectPremiumOrTeaser()` is therefore a defensive heuristic (marker selectors + CTA text patterns + a body-length floor), not something confirmed against a real live paywalled MI article. Exercised offline via the dedicated `sample-article-premium.html` fixture in this gate (see check 8c) and works as designed; real-world accuracy of the heuristic itself remains unverified until a live premium sample is seen.
9. **No 3rd-party/independent verification of any of the three adapters' live-site structural claims** (IDN Times' category-hub HTML shape/robots.txt reading, Republika's `/index/{offset}` step size and malformed double-slash URL variant, Media Indonesia's offset-pagination step and Cloudflare-challenge behavior) — this gate is fixture-path QA only, per its explicit scope; these claims are taken on the strength of each implementer's own documented live-verification notes (or, for Media Indonesia, its explicitly-flagged proxy-tool limitation) and are not independently re-crawled here.

## How I verified (commands)

```bash
# Adapter shape + registry regression (all 14 sources)
node -e "const { getAdapter, listAdapterIds } = require('./src/adapters'); \
  const { assertAdapterShape } = require('./src/core/adapterContract'); \
  const ids = listAdapterIds(); console.log('ids:', ids, ids.length); \
  for (const id of ids) { assertAdapterShape(getAdapter(id)); console.log(id, 'OK'); }"

# Fixture smoke tests (offline, no CRAWL_LIVE)
node fixtures/idn_times/smoke-test.js
node fixtures/republika/smoke-test.js
node fixtures/media_indonesia/smoke-test.js

# N5 snake_case scan (ad hoc probe, not committed) — idn_times/republika/media_indonesia
node -e "/* see report body: parses each coreAdapter directly, regex-scans keys for camelCase */"

# Wave A specifics: category-hub (not /indeks) discovery + hyperlocal-subdomain exclusion (idn_times)
node -e "const raw = require('./src/adapters/idn_times'); \
  console.log(raw.buildCategoryUrl(), raw.buildCategoryUrl({category:'sport'})); \
  console.log(raw.isArticleUrl('https://bali.idntimes.com/news/indonesia/contoh-artikel-00-abcde-fghijk'));"

# Wave A specifics: offset-path (not ?page=) pagination shape (media_indonesia)
node -e "const raw = require('./src/adapters/media_indonesia'); \
  console.log(raw.buildIndeksUrl({offset:40}), raw.buildCategoryUrl({category:'ekonomi', offset:40}));"

# Disposable local Postgres for the store/idempotency checks (reuses .env's existing port,
# so no .env edit needed)
docker run --name egi_crawl_s6a_qa -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
npm run migrate

# crawl:once fixture path for idn_times/republika/media_indonesia, run 1 (stored) and run 2 (duplicate)
npm run crawl:once -- --source=idn_times --limit=1        # x2
npm run crawl:once -- --source=republika --limit=1        # x2
npm run crawl:once -- --source=media_indonesia --limit=1  # x2

# Regression spot-check: 2 of the 11 prior sources still store successfully
npm run crawl:once -- --source=tirto --limit=1
npm run crawl:once -- --source=okezone --limit=1

# Row-count / idempotency confirmation
docker exec egi_crawl_s6a_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, COUNT(*) FROM articles GROUP BY source_id ORDER BY source_id;"
docker exec egi_crawl_s6a_qa psql -U egi -d egi_crawl -c \
  "SELECT source_id, display_name, adapter_version FROM sources ORDER BY source_id;"

# Live-safety fail-fast spot-check (isolated, CRAWL_LIVE never actually set)
node -e "const { resolveDiscoverLimit } = require('./src/core'); \
  try { resolveDiscoverLimit({ explicitLimit: undefined, liveCrawl: true }); } \
  catch (e) { console.log('fail-fast OK:', e.message); }"

# Cleanup
docker rm -f egi_crawl_s6a_qa
```

No adapter, core, or db source file was modified during this QA pass. `.env` was read but never
edited (its existing `DATABASE_URL` port happened to already match the disposable container
convention). The only artifact of this gate is this report.

---

## GO
IDN Times, Republika, and Media Indonesia all pass adapter-shape, N5 snake_case, fixture smoke, and live-DB store/idempotency checks, and each satisfies its Wave-A-specific task-brief requirement: IDN Times discovers via a category hub (never `/indeks`) with hyperlocal subdomains structurally excluded via an explicit single-host allowlist; Republika's `/indeks` fixture genuinely discovers offline across multiple kanal/region subdomains with the "regional seeds deferred" scope reduction confirmed non-blocking; Media Indonesia's premium/teaser heuristic correctly drops `content_text` confidence without faking content, and its pagination is proven to be offset-path-based, never `?page=`. No regression on the 11 prior sources.
