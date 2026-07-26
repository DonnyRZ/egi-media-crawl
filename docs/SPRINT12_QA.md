# Sprint 12 QA — S12-D Quality Gate

**Verdict: GO**

**Scope:** Verify Sprint 12 deliverables from S12-A (per-source schedule profiles /
`docs/SCHEDULE_PROFILES.md`), S12-B (all-17 `PROFILE_DERIVED` rate limits + restricted
floor), and S12-C (`npm run schedule:all` wiring via `listAdapterIds()`). LOCAL only,
fixture-first. No live crawl of all 17. No feature rewrites (no blocker typo found).

**Environment:** Compose stack already healthy (`egi-crawl-postgres` on `127.0.0.1:5434`,
`egi-crawl-redis` on `127.0.0.1:6379`). Editorial `egi-postgres` (:5433) untouched.
`.env` kept `CRAWL_LIVE=false`. All BullMQ `discover-schedule:*` schedulers created during
this gate were removed afterward; discover/fetch/parse queues obliterated. No orphan
schedulers left (`getJobSchedulers()` owned-prefix count = 0).

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run smoke:rate-limits` — PASS; beritasatu/tribunnews ≥ 5000 | ✅ PASS | All 17 adapters `match=ok`; `beritasatu`/`tribunnews` `delay_ms=5000`, `restricted=yes`; probe exit 0 (`all registered adapters have profile-derived delays configured`). |
| 2 | Spot-check `getDiscoverJobOptions` / profiles across tiers vs `SCHEDULE_PROFILES.md` | ✅ PASS | `detik` → 15m/2h; `viva` → 20m/3h; `tempo` → 30m/4h; `beritasatu`/`tribunnews` → 60m/6h. `listAdapterIds().length === 17`. Adapter `getSourceProfile()` values match the doc table. |
| 3 | Redis/Postgres up (`stack:ps`); editorial 5433 untouched | ✅ PASS | `egi-crawl-postgres` / `egi-crawl-redis` Up (healthy) on 5434/6379. No compose service binds 5433. |
| 4 | Unset `SCHEDULE_SOURCES` → `npm run schedule` → registeredCount 0 | ✅ PASS | `scheduler_noop` + `scheduler_summary` `{registeredCount:0, skippedCount:0, removedCount:0}`. |
| 5 | `npm run schedule:staging` → 2 schedulers (detik/suara) | ✅ PASS | `registeredCount:2`, intervals `2` (staging override). |
| 6 | `npm run schedule:all` with `CRAWL_LIVE` unset/false → registeredCount 17; profile intervals | ✅ PASS | Banner: 17 ids from `listAdapterIds()`, `fixture-first (CRAWL_LIVE not forced true)`, `using per-source profile intervals`. Summary `registeredCount:17`; intervals 15/20/30/60 match profiles (e.g. detik/suara 15, viva/cnn/… 20, tempo/… 30, beritasatu/tribunnews 60). |
| 7 | Safety: `CRAWL_LIVE=true` without limit → skip; with `SCHEDULE_DISCOVER_LIMIT=2` → register | ✅ PASS | No-limit: `skippedCount:17` (`unbounded_live_limit`), `registeredCount:0`, prior 17 schedulers removed. With limit=2: `registeredCount:17`, each `limit:2`. Then cleaned via shrink (check 8). |
| 8 | Shrink: re-run `schedule:staging` → back to 2, extras removed | ✅ PASS | `registeredCount:2`, `removedCount:15` (all non-staging sources torn down). |
| 9 | Optional short fixture soak — ≥1 discover tick for a couple sources | ✅ PASS (fixture) | Staging @ 2m + `npm start` (`CRAWL_LIVE` unset / `.env` false). Worker log: repeated `discover_job_done` for `detik` (`discovered:2, enqueued:2`). Redis completed-job audit for the same window also showed paired `suara` ticks (same timestamps as detik; `iterationCount` 8 both schedulers). No long live crawl of 17. Worker stopped; schedulers removed; queues obliterated. |

## GO criteria re-check

- **S12-A profiles** — yes; spot-check + `schedule:all` intervals match `SCHEDULE_PROFILES.md`.
- **S12-B rate limits** — yes; smoke PASS; restricted floor ≥ 5000 for beritasatu/tribunnews.
- **S12-C wiring** — yes; `schedule:all` sets allow-list from `listAdapterIds()` (17), does not force `CRAWL_LIVE`; unset `SCHEDULE_SOURCES` still schedules nothing; `schedule:staging` unchanged.
- **Safety + shrink** — yes; unbounded-live skip and limit-resolves path both verified against real Redis.
- **Cleanup** — yes; zero owned `discover-schedule:*` schedulers left; queues obliterated.
- **No banned live crawl of all 17** — yes; fixture-first throughout soak; live flag only used for register/skip safety checks.

→ **GO**

## Out of scope (confirmed not touched)

- No adapter/profile/rate-limit/scheduler feature rewrites.
- No VPS deploy; no editorial DB writes.
- No unbounded or sustained live crawl of the full 17-source set.

## Residuals / follow-ups (non-blocking) — Sprint 13

1. **Fetch-job idempotency hides re-fetch on soak** — `enqueueFetch` uses stable `jobId` from `(sourceId, url)`. After fixture URLs have already completed once, later discover ticks still report `enqueued:N` but may not produce new `fetch_job_*` logs if BullMQ retains the completed job id. Soak evidence should prefer discover ticks (or obliterate fetch queue / rotate job ids) when proving the full pipeline.
2. **Immediate scheduler iterations on upsert** — `upsertJobScheduler` can enqueue an iteration right away. A register of all 17 (even fixture, or `CRAWL_LIVE=true` + limit) will produce a burst if any worker is already up. Ops should ensure no orphan worker before broad register tests, or shrink/cleanup promptly (this gate did).
3. **Derived fetch delay collapses to 5000ms for all current tiers** — with `MAX_DERIVED_DELAY_MS=5000` and intervals 15–60m, every PROFILE_DERIVED source (including restricted) resolves to 5000ms. Tier differentiation today is in **discover interval / overlap**, not per-fetch delay. S13 may want a richer delay curve or accept this as intentional politeness.
4. **Overlap-hint parseability (carried from S8)** — Indonesian listing hints still often fail bare `Date` parse; overlap stop falls back to limit-slice on fixture (and some live) paths.
5. **Soak terminal log vs Redis for dual-source ticks** — during this gate’s worker stdout, only `detik` discover lines appeared, while Redis completed jobs showed matching `suara` ticks in the same seconds. Treat Redis (or structured multi-worker awareness) as source of truth when correlating dual-scheduler soaks; investigate orphan/second worker or log interleaving if it recurs.
6. **Compose orphan Redis note (from S11)** — host `egi-redis` must stay off :6379 so compose Redis can bind.

## How I verified

```bash
npm run stack:ps
npm run smoke:rate-limits
node -e "…getDiscoverJobOptions spot-check tiers…"
# PowerShell: clear SCHEDULE_* then:
npm run schedule
npm run schedule:staging
npm run schedule:all
$env:CRAWL_LIVE='true'; npm run schedule:all          # skip unbounded
$env:CRAWL_LIVE='true'; $env:SCHEDULE_DISCOVER_LIMIT='2'; npm run schedule:all
Remove-Item Env:CRAWL_LIVE, Env:SCHEDULE_DISCOVER_LIMIT
npm run schedule:staging   # shrink
npm start                  # short fixture soak, then stop
# cleanup: removeJobScheduler(discover-schedule:*); obliterate discover/fetch/parse
```

## Files written (S12-D)

- `docs/SPRINT12_QA.md` — this gate
