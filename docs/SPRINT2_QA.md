# Sprint 2 QA — S2-C Quality Gate

**Verdict: GO**

**Scope:** Verify S2-B's claimed fixes against `docs/SPRINT2_GAP_AUDIT.md` (S2-A). Read-only
verification plus fixture/pipeline runtime checks (no live network, no DB). No production code
was modified by this pass; the only artifact of this sprint stage is this report.

**Method:** Static re-read of every file S2-B touched, plus three throwaway runtime checks (a
temp verification script, deleted after use, and two ad-hoc `node -e` probes) exercising the
real `coreAdapter.js` bridges against the bundled fixtures and the real `runPipeline`/
`upsertArticle` code paths (no source edits).

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | P0 closed: `canonical_url` non-optional in typedef | ✅ PASS | `src/core/types.js` L113: `@property {string} canonical_url` (no brackets), grouped with `title`/`content_text` under a new "adapter/bridge MUST supply, no fallback" legend (L97-106). |
| 1 | P0 closed: `pipeline.js` has a fallback when an adapter omits `canonical_url` | ✅ PASS | `src/core/pipeline.js` L233-242: after the `...parsed` spread, an explicit `if (!article.canonical_url) { article.canonical_url = article.normalized_url \|\| article.final_url \|\| null; }` guard. Verified live: fed `runPipeline` an adapter whose `parse()` returns no `canonical_url` — result status `parsed`, `article.canonical_url` came back populated from `normalized_url` instead of `null`. |
| 2 | Fixture parse via `coreAdapter` for detik/suara/viva — snake_case only, no camelCase leakage | ✅ PASS | Ran all three bridges' `parse()` against bundled fixtures (detik/suara fixture-fallback when `html` is empty; viva via `discover()` → fixture URL → `parse()`, matching its own `smoke-test.js` pattern). Key-name regex scan (`/^[a-z]+[A-Z]/`) found **zero** camelCase keys (no `thumbnailUrl`, `publishedAt`, `externalId`, `canonicalUrl`, etc.) on any of the 3 returned objects — confirms the audit's "brand-new object, no `...draft` spread" observation still holds after S2-B's edits. |
| 2 | detik has `field_provenance` | ✅ PASS | `detik/coreAdapter.js` now has `buildFieldProvenance()` (L72-79) and sets it unconditionally in `toParsedArticle()` (L126). Live fixture parse returned a 4-key object (`canonical_url`, `title`, `content_text`, `published_at`), closing the P1 gap noted in the audit. |
| 2 | `stripPageParam`: `?page=2` stripped, canonical URL otherwise intact | ✅ PASS | Called `detik.stripPageParam` and `suara.stripPageParam` (bridge-level, new in S2-B) and `viva`'s pre-existing raw `stripPageParam` directly with `https://x/y?page=2&foo=bar` → all three returned `https://x/y?foo=bar` (page removed, other params preserved). Also confirmed via fixture parse that all three bridges' real `canonical_url` output is page-param-free. |
| 3 | `published_at` soft-warning: missing field adds warning, doesn't fail `assertStorable` | ✅ PASS | `src/db/articles.js` unchanged from the audit's confirmed-working description: `REQUIRED_ARTICLE_FIELDS` (L20-31) excludes `published_at`; `buildValidationWarnings()` (L46-52) appends `missing_published_at` instead of throwing. Live-verified: called the real `upsertArticle()` with a mock article containing every `REQUIRED_ARTICLE_FIELDS` entry but **no** `published_at` — it passed `assertStorable()` cleanly (no `TypeError: ...missing required field(s)...`) and only failed later at the DB-connection layer (`AggregateError`, expected with no live Postgres in this check), proving the missing-`published_at`-alone case is never rejected by the store gate. |
| 4 | `fieldContract.js` exported from `core/index.js` | ✅ PASS | `src/core/index.js` L16 imports `{ REQUIRED_ARTICLE_FIELDS, SOFT_REQUIRED_ARTICLE_FIELDS, N5_OPTIONAL_FIELDS }` from `./fieldContract` and re-exports all three (L49-51). `src/core/fieldContract.js` itself is new and correctly separates hard-required (10 fields, matches `src/db/articles.js`'s own list exactly), soft-required (`published_at`), and fully-optional N5 fields. |

## GO criteria re-check

- **P0 closed** — yes (typedef fix + pipeline fallback, both verified live, not just read).
- **No camelCase leakage on bridge output for the three pilots** — yes, verified live against real fixtures for detik, suara, and viva.
- **Soft `published_at` behavior intact** — yes, verified live against the real `upsertArticle`/`assertStorable` code path.
- **Report written** — this file.

All four GO conditions are met → **GO**.

## Residual P1 (carried over from S2-A, still open — none are blockers)

1. **VIVA has no `tags` extraction path.** Still true after S2-B: `viva/coreAdapter.js`'s
   `toParsedArticle()` (L100-124) has no `tags` key at all, now with an explicit deferral
   comment (L120-123) instead of silence. Per the task brief this was intentionally deferred
   ("viva tags comment deferred") — acceptable for Sprint 2, tracked for a future pass when/if
   a real selector is found.
2. **`canonical_url` derivation robustness — now closed, downgrading from P1 to done.** The
   audit's P1 item ("detik/suara don't defensively strip a page param") is now fixed: both
   bridges added their own `stripPageParam()` (mirroring VIVA's pre-existing one) and apply it
   to `draft.url` before assigning `canonical_url`. No residual action needed here.
3. **`field_provenance` inconsistency — now closed.** The audit's P1 item about detik never
   setting `field_provenance` is fixed (see checklist #2 above). No residual action.

Net residual P1 count: **1** (VIVA tags — accepted as deferred, not a regression).

## Residual P2 (unchanged, no action needed — restated from S2-A for completeness)

- `language` hardcoded to `"id"` in all three bridges — accepted by design.
- `subtitle` unimplemented everywhere — consistent absence, not a mismatch.
- VIVA `updated_at_source` "low confidence" — already documented at the correct layer.
- `parser_version` duplicates `adapter_version` in all three bridges — harmless, no action.

## New observation (not blocking, worth a future note)

- `detik/coreAdapter.js`'s `buildFieldProvenance()` now returns a static 4-key object
  unconditionally (not derived from what the raw draft actually found), unlike suara's
  conditional/derived approach (`fieldProvenance` built from `draft.multipage`/`draft.externalId`)
  or viva's per-draft-derived version (`pages_merged: draft.pagesMerged || 1`). This is
  functionally fine (matches the audit's suggested "minimal, at least X entries" recommendation)
  but means detik's `field_provenance` doesn't yet vary per-article the way its siblings' do.
  Not a gap — just a shallower implementation of the same feature. No action required for
  Sprint 2.

## Verification method notes (for reproducibility)

- No permanent test files were added; verification used a temporary script
  (`.tmp-s2c-verify.js`, deleted after this pass) that called each `coreAdapter.parse()`
  directly against bundled fixtures, plus two inline `node -e` probes for the pipeline
  fallback and the `upsertArticle` soft-required check.
- No `db/migrations/*.sql`, `target-sites.md`, or playbook files were touched or re-verified
  in this pass (out of scope per task constraints).
- No new media/sources were added or exercised.
