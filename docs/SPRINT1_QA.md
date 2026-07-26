# Sprint 1 QA Report

**Agent:** Sprint 1 Agent S1-C (Quality gate / verifikator)
**Scope:** Verify S1-B's live-smoke evidence (`docs/SPRINT1_SMOKE_RAW.md`) for `detik`, `suara`,
`viva` (`--limit=2`, 2 runs each) against the Sprint 1 GO checklist, and confirm S1-A's VIVA
`/indeks` selector fix actually restored live discovery. This pass is **read/verify-only**: no
live crawl was re-run, no adapter/core code was touched, and no fixes were made — the evidence in
`SPRINT1_SMOKE_RAW.md` is internally consistent and independently corroborated by the current
source code (see per-gate notes), so a re-run was not needed to reach a verdict.

## GO / NO-GO

**GO for Sprint 1.**

All five checklist gates pass. VIVA's `/indeks` markup-drift issue flagged as a non-blocking note
in `docs/SPRINT0_QA.md` is confirmed fixed by S1-A: live discovery now returns real candidates
(2/2) instead of the previous 0. Idempotency, field-fill (thumbnail/summary/published_at), and
DB isolation from the editorial database all check out across all three sources.

## Checklist

| # | Gate | Result | Evidence |
|---|------|--------|----------|
| 1 | Limit respected (≤2 per run) | ✅ PASS | Every run (3 sources × 2 runs = 6 runs) logged `discovered 2` and `2/2 article(s) stored/deduped`; no run exceeded `--limit=2`. Command lines in `SPRINT1_SMOKE_RAW.md` §"Commands run" all use `CRAWL_LIVE=true ... --limit=2`, consistent with the fail-fast/limit contract verified in `docs/SPRINT0_QA.md` Gates 2/2b/3. |
| 2 | Detik + Suara + VIVA: ≥1 live article with thumb + summary checked | ✅ PASS | Each source has 2 live rows (6 total) with real canonical URLs, non-fixture domains (`news.detik.com`, `www.suara.com`, `www.viva.co.id`), `has_thumb=t` and `has_summary=t` for all 6, plus sample `thumbnail_url` / `summary_preview` text shown per source in the raw doc's SQL evidence section. |
| 3 | VIVA not SKIP (should be PASS after S1-A) | ✅ PASS | VIVA run 1 discovered 2 real candidates and stored both as `new_article` — a change from `SPRINT0_QA.md`'s Gate 3 result (0 candidates, `.articles--item` selector no longer present). Corroborated directly in current source: `src/adapters/viva/index.js` (~L164-169) now selects `.article-list-row` / `a.article-list-title` / `.article-list-date span` with an explicit comment noting the old `.articles--item*` selectors "no longer exist on the page (markup drift) — this replaces them." This matches S1-B's empirical result exactly. |
| 4 | Run 2 idempotent | ✅ PASS | Run 2 for every source discovered the **same 2 URLs** and produced 0 stored / 2 `duplicate (duplicate_content)`. The raw doc's idempotency SQL shows `rows = distinct_urls = 2` for all three sources after both runs (no row-count growth), and `discovered_urls` bookkeeping also held at 2/source — consistent with the unique-constraint + content-hash dedup already proven on the fixture path in `docs/DB_VERIFY_REPORT.md`. |
| 5 | No editorial DB touched | ✅ PASS | S1-B used a disposable container `egi_crawl_qa` (port `5435`), explicitly distinct from the editorial `egi-postgres` (port `5433`), and removed it after the session (`docker rm -f egi_crawl_qa`). Same isolation convention as `SPRINT0_QA.md` and `DB_VERIFY_REPORT.md`. No adapter/core/README/`.env.example`/`target-sites.md` files were modified. |

**Result: 5/5 gates pass.**

## Cross-checks performed by S1-C

- Re-read `docs/SPRINT0_QA.md` and `docs/DB_VERIFY_REPORT.md` to confirm the limit/fail-fast
  mechanism (`src/core/crawlLimit.js` via `scripts/crawl-once.js`) and idempotency guarantees
  (unique `(source_id, canonical_url)` constraint + content-hash dedup) that S1-B's smoke run
  relies on were already proven, rather than re-deriving them from scratch.
- Read `src/adapters/viva/index.js` directly to confirm the `/indeks` selector fix (`.article-list-row`
  etc.) referenced by S1-B as "S1-A's fix" actually exists in the codebase and matches the
  behavior S1-B observed live — did not just take the claim in the raw doc at face value.
- Confirmed `summary` extraction logic exists in `src/adapters/viva/index.js` (JSON-LD
  `description` → `og:description` → `meta[name=description]`), explaining why S1-B's live VIVA
  rows have `has_summary=t` despite `docs/PILOT_REPORT.md` (an earlier, fixture-only pass) noting
  VIVA's `summary` was `undefined` at that time — this is not a contradiction, just a since-fixed
  gap, and not part of this sprint's scope to re-verify further.
- Confirmed `package.json`'s `crawl:once` script and `scripts/crawl-once.js`'s `--limit`/`CRAWL_LIVE`
  handling match the exact command forms used in `SPRINT1_SMOKE_RAW.md`.
- Did not re-run a live crawl. The raw doc's evidence (stdout counts + SQL query results, not just
  prose claims) was judged sufficiently concrete and internally consistent (run 1 vs run 2 counts,
  URL lists, fill-rate tables) to avoid an unnecessary extra live hit against detik/suara/viva.

## Residual risks (non-blocking)

1. **Small sample size.** Only N=2 articles per source (N=6 total) were exercised live. This is
   sufficient to prove limit-safety, idempotency, and basic field-fill, but not enough to estimate
   real-world fill-rate reliability (e.g. rare missing-thumbnail/summary edge cases) at scale.
2. **`language` / `field_provenance` columns not checked.** Migration `002_add_summary_language_provenance.sql`
   added three nullable columns (`summary`, `language`, `field_provenance`); S1-B's SQL evidence
   checked `summary`/`thumbnail_url`/`published_at` fill but not `language` or `field_provenance`.
   Likely still `NULL` for all three adapters (no adapter code currently populates them) — worth
   confirming explicitly in Sprint 2's N5 hardening pass rather than assuming.
3. **VIVA markup drift already happened once** (Sprint 0 → Sprint 1) with no automated detection —
   the fix required a human/agent to notice `0` candidates and re-inspect the live page. No
   drift-detection alerting exists yet, so a future markup change on any of the 3 sources could
   silently degrade to 0 candidates again before anyone notices.
4. **Worker (BullMQ) path not exercised live.** S1-B (and this QA pass) only exercised
   `scripts/crawl-once.js`. `src/workers/handlers/discover.js` has the same `CRAWL_LIVE`/limit
   gating per `docs/PILOT_REPORT.md`, but was not re-verified against a live run in Sprint 1.
5. **Only 3 of 50 target sites have adapters.** Per `target-sites.md`, `detik`/`suara`/`viva` are
   3 of 50 planned sources — the pilot proves the pipeline pattern works, not full catalog coverage.
6. **Stale `.env` `DATABASE_URL` convention persists.** Following the same pattern as
   `SPRINT0_QA.md`/`DB_VERIFY_REPORT.md`, the local `.env` is left pointing at a disposable
   container that gets removed at the end of each QA session. Not a safety issue (each report
   documents recreation steps), but a minor recurring friction point for whoever runs the next
   session.
7. **No error-path coverage.** Network failures, non-200 responses, and malformed live HTML were
   not exercised in this smoke run (all 6 live fetches succeeded cleanly) — resilience under
   adverse conditions remains unverified.

## Recommended next sprint

**Sprint 2 — N5 hardening**, before adding more adapters:

- Confirm/fill `language` and `field_provenance` for the 3 pilot adapters (residual risk #2).
- Add lightweight drift detection for discover selectors (e.g. alert/log if `discover()` returns 0
  live candidates when a non-zero count is expected) to catch the next VIVA-style markup change
  faster (residual risk #3).
- Exercise the BullMQ worker (`crawl-discover`/`discover.js`) path live at least once, not just
  `crawl:once` (residual risk #4).
- Add basic error-path tests (simulated timeout/4xx/5xx, malformed HTML) for at least one adapter
  to validate failure handling before scaling to more sources (residual risk #7).

Once N5 hardening is in a good state, proceed to **Sprint 3 — adapters** to expand from 3 to the
next batch of `target-sites.md` sources (e.g. Kompas, Tempo, CNN Indonesia, Antara — the next tier
in "Media umum utama").

## Cleanup

No environment changes were made by this QA pass (read-only verification of existing evidence and
source code; no crawl was run, no database was touched, no files besides this report were created).
