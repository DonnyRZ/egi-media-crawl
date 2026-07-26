# Local stack runbook (egi-media-crawl)

Short path for a VPS-shaped local setup: **containers for Postgres + Redis only**; Node worker runs on the host.

For the full deployment-ready checklist (process order, backup sketch, out-of-scope,
local tick list) see [VPS_READY.md](./VPS_READY.md).

## Ports

| Service | Host bind | Credentials / notes |
|---|---|---|
| Crawl Postgres | `127.0.0.1:5434` → container `5432` | `egi` / `egi` / `egi_crawl` |
| Crawl Redis | `127.0.0.1:6379` | `redis://127.0.0.1:6379` |
| Editorial Postgres | `127.0.0.1:5433` | **Not this stack** — do not point `DATABASE_URL` here |

Compose services: `egi-crawl-postgres`, `egi-crawl-redis`. Volumes persist across `stack:down`.

## Commands

```bash
cp .env.example .env          # once; keep existing .env if already aligned
npm install

npm run stack:up              # docker compose up -d
npm run stack:ps              # both should be (healthy)
npm run migrate               # against crawl DB on 5434

# or one-shot: up + health wait + migrate
npm run dev:up

npm start                     # long-lived BullMQ workers (needs Redis + Postgres)
```

Stop infra (keeps volumes):

```bash
npm run stack:down            # docker compose down
```

Wipe data volumes only when you intend to: `docker compose down -v`.

Optional schedules (Windows-safe wrappers): `npm run schedule:staging` (detik+suara @ 2m)
or `npm run schedule:all` (every `listAdapterIds()` source; fixture-first — does not set
`CRAWL_LIVE`). After either, keep the worker running (`npm start`). Unset `SCHEDULE_SOURCES`
still schedules nothing.

## Fixture-first (safe default)

- Keep `CRAWL_LIVE=false` (or unset) unless you deliberately need live HTTP.
- Fixture crawl does not need Redis:

  ```bash
  npm run crawl:once -- --source=detik --limit=1
  ```

- Workers + scheduler need Redis. Live mode additionally requires an explicit limit (`CRAWL_LIMIT` / `--limit` / `SCHEDULE_DISCOVER_LIMIT`).

## Periodic report health (`npm run report:check`)

Same markdown report as `npm run report`, plus threshold exit codes (Postgres only, no Redis).
Safe defaults: empty/idle window → exit `0`. Details and env knobs: README "Reporting" and
`.env.example`. **Hook for `docs/VPS_READY.md` (S14-B):** recommend cron / Task Scheduler
calling `npm run report:check` hourly after the worker is up; do not treat exit `2` as a
compose failure — log and alert separately.

```bash
npm run smoke:report-check    # offline threshold smoke
npm run report:check          # needs DATABASE_URL + migrated crawl DB on 5434
```

## Editorial DB warning

This compose **never** binds or writes editorial `egi-postgres` on **5433**.  
`DATABASE_URL` must stay on **5434** / `egi_crawl`. There is no path in this service that INSERT/UPDATEs the editorial articles database.
