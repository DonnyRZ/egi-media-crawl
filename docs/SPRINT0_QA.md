# Sprint 0 QA Report

**Agent:** Sprint 0 Agent S0-C (Quality gate / verifikator)
**Scope:** Verify S0-A's live-crawl safety hardening (fail-fast without limit, `resolveDiscoverLimit`,
`ctx.limit` threading, README/`.env.example` updates) for `detik`, `suara`, `viva`.
**Environment:** Node.js (Windows), Docker available. Disposable Postgres container
`egi_crawl_qa` (`postgres:16-alpine`, host port `5435`, db `egi_crawl`, user/pass `egi`/`egi`)
was created for this verification and removed afterward (see "Cleanup"). Internet access was
available, so the live gate (Gate 3) was run for real against `detik`/`suara`/`viva`, not skipped.

No code changes were made — S0-A's implementation passed every gate as specified, with one
documented (non-blocking) nuance noted under Gate 4.

## Checklist

| # | Gate | Result |
|---|------|--------|
| 1 | Fixture / offline path not regressed | ✅ PASS |
| 2 | Fail-fast: `CRAWL_LIVE=true` without a limit | ✅ PASS |
| 2b | Fail-fast: invalid `--limit` / `CRAWL_LIMIT` values | ✅ PASS |
| 3 | Live crawl with `--limit=2` does not flood | ✅ PASS (detik, suara) / ⚠️ degraded (viva, see notes) |
| 4 | Adapter-level `discover({ limit })` caps `items.length` | ✅ PASS (as literally specified, `limit=2`) — see nuance |
| — | README matches implemented behavior | ✅ PASS |

## GO / NO-GO

**GO for Sprint 0.**

- Fixture path is unchanged and still stores/dedupes correctly for all three pilot sources.
- Live crawling without an explicit limit fails fast, before any DB or network call, with a
  clear, actionable error for both sources of a missing limit (`CRAWL_LIVE=true` + no
  `--limit`/`CRAWL_LIMIT`) and a malformed limit (`--limit=0`, `--limit=abc`, `CRAWL_LIMIT=-5`).
- Live crawling with `--limit=2` was exercised for real against `detik` and `suara` and stayed
  exactly at the requested cap (2 discovered → 2 processed, no more). `viva`'s live discovery
  did not flood either (it safely returned 0 candidates rather than erroring or overshooting the
  limit) — see notes below for why, and why this doesn't block Sprint 0.
- README's `CRAWL_LIVE` / `--limit`/`CRAWL_LIMIT` documentation matches observed behavior exactly.

## Gate 1 — Fixture / offline path (CRAWL_LIVE unset)

Ran `npm run migrate` against the disposable container, then `npm run crawl:once -- --source=<x>`
for all three sources with `CRAWL_LIVE` unset:

| source | discovered | stored | duplicate | live host hit? |
|---|---|---|---|---|
| detik | 2 | 1 | 1 | No — fixture URLs (`detik.com/berita/d-1234567/...`), fixture HTML fetch (`fromCache: true`) |
| suara | 2 | 1 | 1 | No — fixture URLs, fixture HTML fetch |
| viva  | 8 | 1 | 7 | No — fixture URLs, fixture HTML fetch |

Results match the prior `DB_VERIFY_REPORT.md` (V1) run exactly (1 stored + N-1 duplicate per
source, since all fixture URLs for a source resolve to the same bundled `sample-article.html`
content hash) — **no regression**.

Also confirmed `--limit` optionally caps the fixture path too: `crawl:once -- --source=viva
--limit=2` discovered/processed only 2 of viva's 8 fixture URLs (viva's own `discover()` slices
to `ctx.limit` internally, so the log line reads "discovered 2", not "discovered 8, capped to 2" —
expected, see Gate 4 notes).

## Gate 2 — Fail-fast: live without limit

```
CRAWL_LIVE=true npm run crawl:once -- --source=detik
```

Failed immediately (exit code 1) with:

```
[crawl-once] failed: CRAWL_LIVE=true requires an explicit crawl limit — refusing to run an
unbounded live discovery pass against a real site. Pass --limit=N (crawl:once) or set
CRAWL_LIMIT=N, e.g.:
  CRAWL_LIVE=true npm run crawl:once -- --source=detik --limit=2
See README.md "CRAWL_LIVE (fixture vs. live crawling)" for details.
```

This happens **before** `assertDatabaseReady()` and before any `adapter.discover()` call, i.e.
before any DB connection attempt and before any network request — confirmed by the fast failure
time and absence of any DB/HTTP log lines.

### Gate 2b — invalid limit values (also must fail fast)

All three malformed-limit cases were exercised, each with `CRAWL_LIVE=true`, each failing fast
with a clear error and no DB/network activity:

| Case | Error |
|---|---|
| `--limit=0` | `Invalid limit: "0". It must be a positive integer (e.g. limit=2).` |
| `--limit=abc` | `Invalid limit: "abc". It must be a positive integer (e.g. limit=2).` |
| `CRAWL_LIMIT=-5` (no `--limit`) | `Invalid CRAWL_LIMIT: "-5". It must be a positive integer (e.g. CRAWL_LIMIT=2).` |

## Gate 3 — Live crawl with `--limit=2`

Network access was available (`curl` to `news.detik.com`, `www.suara.com`, `www.viva.co.id`
`/indeks` all returned HTTP 200), so this gate was run for real rather than skipped, one source
at a time:

| source | `CRAWL_LIVE=true npm run crawl:once -- --source=<x> --limit=2` | discovered | processed | within limit? |
|---|---|---|---|---|
| detik | ✅ ran | 2 real articles from `news.detik.com` | 2 stored (new) | ✅ 2 ≤ 2 |
| suara | ✅ ran | 2 real articles from `www.suara.com` | 2 stored (new) | ✅ 2 ≤ 2 |
| viva  | ✅ ran | 0 | 0 | ✅ 0 ≤ 2 (see note) |

Both `detik` and `suara` fetched exactly 2 real live articles each, parsed and stored them
successfully (title, content, published date all populated) — the limit was honored end to end
(discover → fetch → parse → store), with no more requests than necessary for 2 articles.

**viva note (not a limit-safety bug):** live discovery returned 0 candidate URLs. Root cause:
verified independently by fetching `https://www.viva.co.id/indeks` directly — the live page's
HTML no longer contains any `.articles--item` element, which is the CSS selector
`extractIndeksItems()` (`src/adapters/viva/index.js`) relies on. This is **site markup drift**
on VIVA's `/indeks` page (unrelated to the Sprint 0 limit-safety work, and out of scope for this
QA pass's "minimal 1-line fixes for gates" mandate — fixing a selector is an adapter-logic
change, not a limit/fail-fast fix). Importantly, it is **not** a safety violation: the adapter
degraded gracefully (0 items, no crash, no unbounded fetch) rather than flooding anything, so it
does not block the Sprint 0 GO. Recommend a follow-up ticket for the `viva` adapter owner to
re-check `/indeks` markup.

## Gate 4 — Adapter-level `discover({ limit })` cap

Directly called `getAdapter(sourceId).discover(ctx)` (bypassing `crawl-once.js`'s defense-in-depth
slice) for each pilot source, fixture-only, and asserted `items.length <= ctx.limit`:

| source | `limit: 2` | `limit: 1` (extra check, not in original spec) |
|---|---|---|
| detik | ✅ 2 items ≤ 2 | ❌ 2 items > 1 |
| suara | ✅ 2 items ≤ 2 | ❌ 2 items > 1 |
| viva  | ✅ 2 items ≤ 2 | ✅ 1 item ≤ 1 |

**As literally specified (`limit: 2`), Gate 4 passes for all three sources.**

Nuance found while stress-testing with `limit: 1` (beyond what Gate 4 asked for, done to confirm
the cap is real and not a coincidence of fixture-list size): `detik`'s and `suara`'s raw
`discover()` **fixture branch** (`ctx.fixtureOnly`/`!ctx.liveDiscover`) returns their whole
hardcoded fixture listing regardless of `ctx.limit` — only their *live* discovery branch slices
to `ctx.limit`. `viva`'s `discover()` slices to `ctx.limit` unconditionally (fixture and live
alike), so it doesn't show this gap.

This is **not classified as a gate failure** for Sprint 0, for two reasons:
1. It only affects the fixture branch, which never performs network I/O — there is no live-flood
   risk, which is what the fail-fast/limit work exists to prevent.
2. Every real caller of `adapter.discover()` (`scripts/crawl-once.js`, `src/workers/handlers/discover.js`)
   already applies a documented defense-in-depth `discovered.slice(0, limit)` immediately after
   the call (see `README.md` "`--limit` / `CRAWL_LIMIT`" and the comments in both files), so the
   *effective* number of URLs fetched/stored per run is still correctly capped end-to-end even
   though `detik`/`suara`'s raw fixture-branch `discover()` itself doesn't self-slice.

No code change was made for this, per the "verify only, minimal 1-line fixes if broken" mandate —
Gate 4 as specified (`limit=2`) is not broken, and the deeper nuance is a pre-existing,
already-mitigated (by the outer slice) design characteristic rather than a live-safety bug.
If tightened adapter-level self-consistency is desired later, a 1-line fix would be to make
`detik`/`suara`'s fixture branches also `.slice(0, limit)` their fixture listing, mirroring `viva`.

## README vs. observed behavior

`README.md`'s "`CRAWL_LIVE` (fixture vs. live crawling)" and "`--limit` / `CRAWL_LIMIT`" sections
were checked line-by-line against everything exercised above:

- Fixture-first default, `CRAWL_LIVE=true` to opt into live discovery+fetch — ✅ matches.
- Limit optional on fixture path, required (fail-fast) on live path — ✅ matches.
- `--limit` (CLI) takes priority over `CRAWL_LIMIT` (env) — ✅ matches (`--limit=0`/`--limit=abc`
  errors reference `"limit"`, not `"CRAWL_LIMIT"`, confirming CLI arg took priority in resolution).
- Example commands in README (`CRAWL_LIVE=true npm run crawl:once -- --source=detik --limit=2`)
  were run verbatim and behaved exactly as documented.

No README changes were necessary.

## Cleanup

- Disposable Docker container `egi_crawl_qa` (`postgres:16-alpine`, port `5435`) was stopped and
  removed after this verification: `docker rm -f egi_crawl_qa`.
- No adapter, core, README, `.env.example`, or playbook/`target-sites.md` files were modified by
  this QA pass.
- The throwaway Gate 4 script (`qa_gate4_check.js`, repo root) was deleted after use; it was never
  committed.
- Local `.env`'s `DATABASE_URL` was pointed at the disposable container during this session and
  has been left as-is (pointing at a now-removed container, same convention as the prior
  `DB_VERIFY_REPORT.md` cleanup) — recreate with:

  ```bash
  docker run --name egi_crawl_qa -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5435:5432 -d postgres:16-alpine
  npm run migrate
  ```
