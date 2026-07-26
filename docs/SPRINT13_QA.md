# Sprint 13 QA — S13-D Quality Gate

**Verdict: GO**

**Scope:** Verify Sprint 13 deliverables from S13-A (shared listing-date parse +
overlap mid-list stop), S13-B (idempotent worker graceful shutdown), and S13-C
(light watermark: skip-enqueue of URLs seen within `overlap_hours`). LOCAL only,
fixture-first. No feature rewrites (no blocker found that required a code fix).

**Environment:** Compose stack already healthy (`egi-crawl-postgres` on
`127.0.0.1:5434`, `egi-crawl-redis` on `127.0.0.1:6379`). Editorial `egi-postgres`
(:5433) untouched — compose binds only 5434/6379. `.env` kept `CRAWL_LIVE=false`.
Watermark proof called `handleDiscover` directly (no schedulers created); owned
`discover-schedule:*` count remained 0; discover/fetch queues obliterated after.

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run smoke:overlap-parse` → OK | ✅ PASS | Exit 0; `[overlap-parse smoke] OK` (Indonesian forms + mid-list stop + time-only stays unparseable). |
| 2 | `npm run smoke:shutdown` → exit 0, shutdown events | ✅ PASS | Exit 0; events `workers_started` → `shutdown_started` (SIGTERM) → `shutdown_already_in_progress` (SIGINT) → `shutdown_complete`; `[smoke-shutdown] OK`. Code path closes workers → `closeQueues` → Redis → `closePool`. |
| 3 | Stack healthy; editorial 5433 untouched | ✅ PASS | `egi-crawl-postgres` / `egi-crawl-redis` Up (healthy) on 5434/6379. Compose comments + ports confirm no 5433 bind. |
| 4 | Watermark: fixture discover twice (detik) — 1st enqueued≈discovered; 2nd skippedSeen≈discovered / enqueued≈0 | ✅ PASS | Direct `handleDiscover` (fixture). **Run1:** `discovered:2, enqueued:2, skippedSeen:0`. **Run2:** `discovered:2, enqueued:0, skippedSeen:2` + `discover_skip_seen` logs; DB `discovery_count` max=2 (rediscovery still recorded). Cleanup: schedulers removed=0/remaining=0; queues obliterated. *Note:* default profile `overlap_hours=2` empties Jul-23 fixture listing after S13-A parse; proof used a temporary 48h profile patch for discoverability only (see residuals). |
| 5 | Residuals doc exists and matches reality | ✅ PASS | `docs/SPRINT13_RESIDUALS.md` present. Matches code: `parseListingDate.js` + `overlap.js`; `tryParseHint` → shared parser on **detik / suara / viva / sindonews**; live detik indeks still omits per-item hint; time-only `"07:08"` intentionally unparseable (smoke asserts). |
| 6 | Optional: `smoke:rate-limits` / schedule unset → 0 | ✅ PASS (sanity) | Rate-limits: all 17 `match=ok`. Unset `SCHEDULE_SOURCES` → `scheduler_noop` + `registeredCount:0`. |

## GO criteria re-check

- **S13-A overlap parse** — yes; smoke PASS; wired adapters match residuals doc.
- **S13-B graceful shutdown** — yes; smoke PASS; idempotent double-call + resource close verified.
- **S13-C light watermark** — yes; second fixture discover skips fetch enqueue within window while still recording rediscovery; not claimed as full §20.4.
- **Cleanup** — yes; no owned schedulers left; test queues obliterated.
- **No feature rewrite** — yes; fixture-date / short-overlap interaction documented as residual only.

→ **GO**

## Out of scope (confirmed not touched)

- No adapter/parse/shutdown/watermark feature rewrites.
- No VPS deploy; no editorial DB writes.
- No full §20.4 watermark / adaptive scheduling.
- No sustained live crawl of the full 17-source set.

## Residuals / follow-ups — Sprint 14

1. **Detik live indeks has no per-item timestamp** — overlap stop works on fixture (when dates fall inside the window) but live detik still degrades to plain `limit` until listing dates are scraped. *(from S13-A residuals)*
2. **Suara live time-only fragments** — `"07:08"` stays unparseable on purpose (no invented day). *(from S13-A residuals)*
3. **Other adapters may still pass relative hints** ("N menit lalu") that the shared parser cannot resolve — safe non-stop. *(from S13-A residuals)*
4. **Fixture listing dates vs short `overlap_hours`** — after S13-A, parseable fixture hints + detik `overlap_hours=2` can yield `discovered:0` when fixture calendar days are outside the window (observed this gate with default profile). Refresh fixture listing dates (or document a fixture-only overlap override) so local E2E discover stays non-empty under real profiles.
5. **Light watermark only** — skip-enqueue + rediscovery; not playbook §20.4/§20.5 adaptive watermark / consecutive-duplicate pagination stop.
6. **Worker discover log omits `skippedSeen`** — `discover_job_done` still logs only `discovered`/`enqueued`; ops correlating soak ticks may want `skippedSeen` in the structured log.
7. **Carry-over from S12 (non-blocking):** fetch-job idempotency on soak; immediate scheduler iterations on upsert; derived fetch delay floor at 5000ms for all current tiers; compose orphan Redis note (`egi-redis` must stay off :6379).

## How I verified

```bash
npm run smoke:overlap-parse
npm run smoke:shutdown
npm run stack:ps
# watermark: temporary _qa_s13_watermark.js — handleDiscover(detik) x2 after
# DELETE discovered_urls for detik; profile overlap_hours patched to 48h for
# fixture discoverability only; then remove schedulers / obliterate queues; delete script
npm run schedule          # SCHEDULE_SOURCES unset → registeredCount 0
npm run smoke:rate-limits
```

## Files written (S13-D)

- `docs/SPRINT13_QA.md` — this gate
