# VPS-ready runbook (local-first)

Deployment checklist for a **future** VPS that mirrors the local process model.
This document is **docs only** — nothing here assumes an actual remote host, TLS, or
installed systemd. Prove readiness on your laptop first.

Sprint gates that underpin this runbook: [SPRINT11_QA.md](./SPRINT11_QA.md) (compose +
DX), [SPRINT12_QA.md](./SPRINT12_QA.md) (profiles + `schedule:all`),
[SPRINT13_QA.md](./SPRINT13_QA.md) (overlap parse, graceful shutdown, light watermark).

Companion day-to-day stack notes: [LOCAL_STACK.md](./LOCAL_STACK.md).  
Per-source cadences: [SCHEDULE_PROFILES.md](./SCHEDULE_PROFILES.md).

## Process model (same on laptop and VPS)

| Layer | What runs | How |
|---|---|---|
| Infra | Postgres + Redis | `docker compose` (`npm run stack:up`) |
| App | BullMQ workers | Node on host: `npm start` (long-lived) |
| Schedule CLI | Upsert/remove job schedulers | Short-lived: `npm run schedule` / `schedule:staging` / `schedule:all` |
| Ops | Migrate, report, report:check | Short-lived CLIs; report needs Postgres only |

**Never** point this service at editorial Postgres (`127.0.0.1:5433`). Crawl DB is
**5434** / `egi_crawl` only. See [LOCAL_STACK.md](./LOCAL_STACK.md).

## Recommended process order

1. **Infra up** — `npm run stack:up` (or `npm run dev:up` for up + health wait + migrate).
2. **Migrate** — `npm run migrate` (idempotent; safe to re-run after pulls).
3. **Worker** — `npm start` (must stay running for scheduled discovers and the queue pipeline).
4. **Schedule** — `npm run schedule:staging` or `npm run schedule:all` (or plain
   `npm run schedule` with an explicit `SCHEDULE_SOURCES` allow-list). Re-run after any
   scheduling env change; shrinks remove dropped sources.
5. **Report (periodic)** — `npm run report` (human-readable) or `npm run report:check`
   (same report + threshold exit codes; see README "Reporting"). Postgres only; no Redis.

Fixture one-shot without Redis: `npm run crawl:once -- --source=<id> [--limit=N]`.

## Required / important env vars

Copy from `.env.example` → `.env`. Do **not** invent or commit production secrets; local
compose defaults (`egi` / `egi`) are fine for laptop proof only.

| Variable | Required when | Notes |
|---|---|---|
| `DATABASE_URL` | Always (migrate, crawl, worker, report) | Host → `localhost:5434` / `egi_crawl` |
| `REDIS_URL` | Worker + schedule CLIs | `redis://127.0.0.1:6379` |
| `CRAWLER_UA` | Live HTTP | Honest UA; see `.env.example` |
| `CRAWL_LIVE` | Opt-in live | Default unset/`false` = fixture-first |
| `CRAWL_LIMIT` | Live discover/fetch | **Required** when `CRAWL_LIVE=true` |
| `SCHEDULE_SOURCES` | Plain `npm run schedule` | Unset → schedule **nothing** |
| `SCHEDULE_DISCOVER_LIMIT` | Live schedules | Prefer over relying on `CRAWL_LIMIT` alone |
| `SCHEDULE_INTERVAL_OVERRIDE_MINUTES` | Soak tests | e.g. `2` for staging |
| `LOG_LEVEL` | Optional | Operator hint |
| `REPORT_SINCE` | Optional | Default window for `npm run report` / `report:check` |
| `REPORT_PARSE_FAIL_*` / `REPORT_REQUIRE_STORED` / `REPORT_MIN_DISCOVERIES` | Optional | Thresholds for `report:check` (safe defaults; see `.env.example`) |
| Restricted UA overrides | Live beritasatu/tribunnews | See `docs/RESTRICTED_UA_POLICY.md` |

Worker pool tuning (`WORKER_CONCURRENCY`, `PGPOOL_*`) is optional — see `.env.example`.

## Compose services + volumes

From `docker-compose.yml`:

| Service / container | Host bind | Volume |
|---|---|---|
| `postgres` → `egi-crawl-postgres` | `127.0.0.1:5434` → `5432` | `egi_crawl_pgdata` |
| `redis` → `egi-crawl-redis` | `127.0.0.1:6379` → `6379` | `egi_crawl_redisdata` (AOF) |

- `npm run stack:down` stops containers and **keeps** volumes.
- `docker compose down -v` wipes data — only when intentional.
- App/worker is **not** in compose; Node stays on the host (VPS-shaped).
- Host orphan Redis (e.g. another `egi-redis`) must stay off **6379** so compose can bind
  ([SPRINT11_QA.md](./SPRINT11_QA.md) residual).

## Fixture-first vs live

| Mode | Flag | Limit | Network |
|---|---|---|---|
| Fixture (safe default) | `CRAWL_LIVE` unset/`false` | Optional | No live HTTP; fixtures under `fixtures/` |
| Live | `CRAWL_LIVE=true` | **Required** (`CRAWL_LIMIT` / `--limit` / `SCHEDULE_DISCOVER_LIMIT`) | Real sites; respect rate limits + restricted UA |

Rules carried from Sprint 11–12:

- Never run live without an explicit limit.
- Unbounded live schedule register is refused (`scheduler_skip_unbounded_live` /
  skip count); set a discover limit first.
- `npm run schedule:all` does **not** force `CRAWL_LIVE=true`.

## `schedule:all` vs staging

| Command | Sources | Interval | Typical use |
|---|---|---|---|
| `npm run schedule:staging` | `detik,suara` | Forced **2m** | Short local soak |
| `npm run schedule:all` | All `listAdapterIds()` (17) | Per-source profiles ([SCHEDULE_PROFILES.md](./SCHEDULE_PROFILES.md)) | Full-registry fixture schedule proof |
| `npm run schedule` | `SCHEDULE_SOURCES` only | Profiles (or override) | Custom allow-list |

- Unset allow-list + plain `schedule` → `registeredCount: 0` (safe noop).
- Shrink: re-run a smaller wrapper (e.g. staging) to remove extras.
- Broad register can enqueue an immediate scheduler iteration — ensure no orphan worker
  before large fixture/live register tests ([SPRINT12_QA.md](./SPRINT12_QA.md)).

## Graceful restart (SIGINT / SIGTERM)

Long-lived worker (`npm start` / `src/workers/index.js`):

- Handles **SIGINT** and **SIGTERM**.
- Shutdown is **idempotent** (second signal shares one in-flight shutdown).
- Order: close workers → close queues → Redis → Postgres pool.
- Prove locally: `npm run smoke:shutdown` ([SPRINT13_QA.md](./SPRINT13_QA.md)).

Ops pattern for restart:

```bash
# stop worker (Ctrl+C, or kill -TERM <pid>)
npm run migrate          # if schema changed
npm start                # start again
npm run schedule:all     # or staging / custom — re-upsert after env/deploy changes
```

Schedule CLIs are short-lived; they do not need signal handling beyond normal Node exit.

## Backup crawl DB (high level)

Local / future VPS — logical dump of **crawl** Postgres only (not editorial):

```bash
# Example shape only — adjust container name / credentials to your .env
docker exec egi-crawl-postgres \
  pg_dump -U egi -d egi_crawl -Fc -f /tmp/egi_crawl.dump
docker cp egi-crawl-postgres:/tmp/egi_crawl.dump ./egi_crawl.dump
```

- Prefer scheduled dumps of `egi_crawl_pgdata` via `pg_dump` over copying the raw volume
  while Postgres is running.
- Redis AOF (`egi_crawl_redisdata`) is queue state; treat as rebuildable from schedules +
  DB, not as the system of record for articles.
- Restore drills and off-host retention are **out of scope** for this sprint (see below).

## Optional future: systemd unit snippets

**Not installed by this sprint.** Illustrative only for a later VPS pass:

```ini
# /etc/systemd/system/egi-crawl-worker.service  (EXAMPLE — do not install yet)
[Unit]
Description=EGI Media crawl workers
After=docker.service network.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/egi-media-crawl
EnvironmentFile=/opt/egi-media-crawl/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/egi-crawl-schedule-all.service  (EXAMPLE oneshot)
[Unit]
Description=EGI Media crawl schedule upsert (all adapters)
After=egi-crawl-worker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/egi-media-crawl
EnvironmentFile=/opt/egi-media-crawl/.env
ExecStart=/usr/bin/npm run schedule:all
```

Pair with a timer unit or cron for periodic health:

```bash
# hourly example — exit 0 healthy, 2 threshold breach, 1 infra error
0 * * * * cd /opt/egi-media-crawl && npm run report:check >> /var/log/egi-crawl-report.log 2>&1
```

Do not treat exit `2` as a compose failure — log/alert separately. Keep compose infra under
`restart: unless-stopped` as today.

## Belum dilakukan / out of scope

Explicitly **not** done in Sprint 14-B (and not claimed by this runbook):

- No actual VPS provision, SSH, or remote deploy
- No TLS, DNS, firewall, or reverse proxy
- No systemd (or other process manager) **installed on a server** — snippets above are
  examples only
- No editorial DB sync / write path (port **5433** stays unrelated)
- No permission/media pipeline into the reader CMS
- No production secrets, credential rotation, or secret-manager wiring
- No automated offsite backup / restore runbook beyond the high-level dump sketch
- No sustained live crawl of all 17 sources as a deploy gate
- No Dockerizing the Node worker into compose (host Node remains the model)

## Checklist — lokal dianggap deployment-ready

Tick on a developer machine before any future VPS cutover:

- [ ] `.env` aligned with `.env.example` / compose (**5434** + **6379**; never **5433**)
- [ ] `npm run stack:up` → both services healthy (`npm run stack:ps`)
- [ ] `npm run migrate` succeeds against `egi_crawl`
- [ ] Fixture path: `npm run crawl:once -- --source=detik --limit=1` (or equivalent)
- [ ] `npm start` reaches `workers_started`; stop with SIGINT/SIGTERM cleanly
- [ ] `npm run smoke:shutdown` → exit 0
- [ ] `npm run smoke:overlap-parse` → OK (Sprint 13)
- [ ] `npm run smoke:rate-limits` → all registered adapters match (Sprint 12)
- [ ] Unset `SCHEDULE_SOURCES` → `npm run schedule` → `registeredCount: 0`
- [ ] `npm run schedule:staging` → 2 schedulers; worker processes ≥1 discover tick (fixture)
- [ ] `npm run schedule:all` with `CRAWL_LIVE` unset → 17 schedulers; profile intervals
- [ ] Live safety: `CRAWL_LIVE=true` without limit → schedule skips unbounded; with
      `SCHEDULE_DISCOVER_LIMIT` → registers (then shrink/cleanup)
- [ ] Periodic report: `npm run smoke:report-check` (offline) + `npm run report:check` (exit 0 on idle/healthy DB)
- [ ] Know how to dump crawl Postgres (`pg_dump` sketch above)
- [ ] Operator has read out-of-scope section — no assumption of TLS/systemd/editorial sync

When every box is green locally, the **process list + env + compose + graceful stop**
story is VPS-shaped. Actual host bring-up remains a later sprint.
