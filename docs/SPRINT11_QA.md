# Sprint 11 QA — Local crawl stack (compose + npm DX)

**Verdict: GO**

**Scope:** Docs + quality gate for S11-A (compose infra) and S11-B (env/npm DX). Confirm healthy local Postgres/Redis on crawl ports, migrate against crawl DB, brief worker smoke in fixture mode, editorial port isolation, and `.env.example` ↔ compose alignment.

**Out of scope / hard bans confirmed:**

- No VPS deploy
- No adapter / schedule-17 changes
- No editorial DB writes
- No rewrite of compose/env beyond docs (A/B files left as delivered)

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run stack:ps` — postgres + redis healthy | ✅ PASS | `egi-crawl-postgres` Up (healthy) `127.0.0.1:5434->5432/tcp`; `egi-crawl-redis` Up (healthy) `127.0.0.1:6379->6379/tcp` |
| 2 | `npm run migrate` against crawl DB on 5434 | ✅ PASS | Applied `001_init.sql`, `002_add_summary_language_provenance.sql`; `[migrate] done. 2 migration(s) applied.` exit `0` |
| 3 | Worker smoke (`npm start` / `node src/workers/index.js`), fixture mode, no crash | ✅ PASS | `CRAWL_LIVE=false` in `.env`; ~5s run logged `workers_starting` (queues discover/fetch/parse) then `workers_started` `count:3`; process stopped cleanly — no Redis/Postgres connection error |
| 3b | Optional fixture crawl-once | ✅ PASS | `npm run crawl:once -- --source=detik --limit=1` → `1/1 article(s) stored/deduped for "detik"` |
| 4 | Editorial port 5433 not used by this stack | ✅ PASS | `docker compose config --services` → `postgres`, `redis` only; crawl binds `5434`/`6379`; editorial `egi-postgres` remains separate on `127.0.0.1:5433` |
| 5 | `.env.example` matches compose ports | ✅ PASS | Both: `DATABASE_URL=...@localhost:5434/egi_crawl`, `REDIS_URL=redis://127.0.0.1:6379`; compose publishes `127.0.0.1:5434:5432` and `127.0.0.1:6379:6379`; comments warn against 5433 |

## GO criteria re-check

- **Infra healthy on crawl ports** — yes (check 1).
- **Migrate succeeds on crawl DB** — yes (check 2).
- **Worker connects without crash in fixture mode** — yes (check 3); optional fixture crawl OK (3b).
- **Editorial 5433 isolated** — yes (check 4).
- **Env template aligned with compose** — yes (check 5).
- **No banned changes** — yes (docs-only for S11-C).

## How I verified

```bash
npm run stack:ps
npm run migrate
# brief worker (PowerShell): start node src/workers/index.js ~5s, confirm workers_started, stop
npm run crawl:once -- --source=detik --limit=1
docker port egi-crawl-postgres   # 5432/tcp -> 127.0.0.1:5434
docker port egi-crawl-redis      # 6379/tcp -> 127.0.0.1:6379
docker port egi-postgres         # 5432/tcp -> 127.0.0.1:5433 (untouched)
```

Worker smoke excerpt:

```json
{"event":"workers_starting","concurrency":2,"queues":["crawl-discover","crawl-fetch","crawl-parse"]}
{"event":"workers_started","count":3}
```

## Files written (S11-C)

- `docs/LOCAL_STACK.md` — runbook (up → migrate → worker; ports; fixture-first; editorial warning; commands)
- `docs/SPRINT11_QA.md` — this gate

## Residuals

- Orphan/host `egi-redis` (if any) must stay off port **6379** so compose Redis can bind; S11-A already stopped a conflicting instance — re-check if `stack:up` fails on bind.
- Real `.env` was already aligned (5434/6379, `CRAWL_LIVE=false`); not modified by S11-C.
- Editorial `egi-postgres` (:5433) and unrelated `egi-media-postgres` (:5435) may still run on the machine; they are outside this compose and must not be used as `DATABASE_URL` for crawl.
