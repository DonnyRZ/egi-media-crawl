# EGI Media Crawl

Reliable, multi-source news article crawler for EGI Media. This service is **separate** from `egi-media-backend` (the editorial CMS/API) and `egi-media-frontend` (the Next.js reader site) — it does **not** write to the editorial articles table and does not serve the public site.

Its job: discover, fetch, parse, validate, and store news articles from external media sources (see `target-sites.md`) into its own database, following the method described in `Reliable-News-Article-Scraping.md`.

## Source of truth

- **Method / architecture / reliability rules:** [`Reliable-News-Article-Scraping.md`](./Reliable-News-Article-Scraping.md)
- **Media to crawl:** [`target-sites.md`](./target-sites.md)

Read both before implementing adapters, migrations, or pipeline logic.

## Status

Foundation scaffold + a working **fixture-backed, end-to-end dry run** for three pilot
sources: `detik`, `suara`, `viva`. By default (i.e. `CRAWL_LIVE` unset), nothing here
live-scrapes any of those sites: `adapter.discover()` returns a small hardcoded/bundled
fixture listing for every pilot source, and every article fetch reads that source's
bundled `fixtures/<sourceId>/sample-article.html` instead of making an HTTP request. See
"CRAWL_LIVE (fixture vs. live crawling)" below before setting it to `true`.

- **F2** — database migrations (`db/migrations`, `scripts/migrate.js`)
- **F3** — core pipeline/interfaces (`src/core`)
- **F4** — BullMQ queue + workers (`src/queue`, `src/workers`)
- **F5** — real source adapters (`src/adapters/{detik,suara,viva}/index.js`)
- **F6** — db persistence (`src/db/articles.js`, `src/db/sources.js`,
  `src/db/discoveredUrls.js`), worker wiring (`src/workers/handlers/*.js`), and the
  one-off crawl entrypoint (`scripts/crawl-once.js`)

Other sources (beyond `detik`/`suara`/`viva`) still need real adapters under
`src/adapters/<sourceId>` before they can be onboarded — see "Contributing a new
source" below.

### Adapter contract note (F5 stub vs F3 core)

Each pilot adapter's raw `src/adapters/<sourceId>/index.js` returns a slightly different
shape than what `src/core` (`runPipeline`) and the db layer expect — e.g. camelCase
`sourceId`/`rawUrl`/`publishedAt` vs. the core's snake_case
`source_id`/`url`/`published_at`, and `discover()` returning `{ items: [...] }` instead
of an array. Each adapter's sibling `coreAdapter.js` (`src/adapters/<sourceId>/coreAdapter.js`)
is a thin mapping layer that bridges this (adds a fixed `adapter_version`, flattens
`paragraphs` into `content_text`/`content_html`, remaps discovery items, etc.) without
changing `src/core` or the raw stub. `src/adapters/index.js` resolves
`getAdapter('detik'|'suara'|'viva')` to the mapped `coreAdapter.js` version in each case,
so every caller (workers, `scripts/crawl-once.js`, `src/sources/registry.js`) sees a
single, core-compatible adapter satisfying `src/core/adapterContract.js`'s
`assertAdapterShape()`.

### Run the fixture crawl (`crawl:once`)

No Redis required — this path calls the adapter and `runPipeline` directly:

```bash
cp .env.example .env   # set DATABASE_URL to a running Postgres
npm install
npm run migrate
npm run crawl:once -- --source=detik
npm run crawl:once -- --source=suara
npm run crawl:once -- --source=viva
```

`--source` accepts any id registered in `src/adapters/index.js` (currently `detik`,
`suara`, `viva`); it defaults to `detik` if omitted. Each run upserts a `sources` row for
that source, runs `adapter.discover()` (fixture URLs by default — see `CRAWL_LIVE`
below), then for each URL: records a `discovered_urls` row, runs the core pipeline (fetch
fixture HTML -> `adapter.parse()` -> content hash -> store), and prints a per-URL status
plus a summary. Re-running is idempotent: unchanged articles report `duplicate` instead
of `stored`. Rows land in `sources`, `discovered_urls`, `processing_status`, `articles`,
and (on first insert / content change) `article_revisions`.

Required environment variable: **`DATABASE_URL`** — a Postgres connection string for the
dedicated `egi_crawl` database (see "Environment setup" below). If it's missing or
Postgres isn't reachable, the script fails fast with a clear error message instead of
hanging; no other env var is required to run the fixture path.

#### `--limit` / `CRAWL_LIMIT` (how many URLs a discover run processes)

`--limit=N` (CLI, highest priority) or the `CRAWL_LIMIT` env var caps how many discovered
URLs `crawl:once` (and the `crawl-discover` worker job) will fetch/parse/store in one run.
It's threaded into `adapter.discover()` as `ctx.limit` (so live adapters cap their own
network fetch/pagination work too — see `src/core/crawlLimit.js`) and enforced again as a
plain array slice after discovery returns, as a defense-in-depth backstop.

- **`CRAWL_LIVE` unset/`false` (fixture path):** a limit is **optional**. Omit it and
  adapters keep their existing fixture-listing defaults (unchanged E2E behavior); pass one
  and it also caps how many of the (already-small) fixture URLs get processed.
- **`CRAWL_LIVE=true` (live path):** a limit is **required**. `crawl:once`/the
  `crawl-discover` worker **fail fast with a clear error** if neither `--limit`/`limit`
  nor `CRAWL_LIMIT` is set, rather than silently defaulting — this is what makes it
  impossible to accidentally kick off an unbounded live crawl against a real site.

> **Never run a live crawl without a limit.** Always pass `--limit`/`CRAWL_LIMIT`
> explicitly alongside `CRAWL_LIVE=true`, and start small (e.g. `2`):
>
> ```bash
> CRAWL_LIVE=true npm run crawl:once -- --source=detik --limit=2
> CRAWL_LIVE=true npm run crawl:once -- --source=suara --limit=2
> CRAWL_LIVE=true npm run crawl:once -- --source=viva --limit=2
> ```

### `CRAWL_LIVE` (fixture vs. live crawling)

`CRAWL_LIVE` is unset/`false` by default, which keeps **every** pilot adapter
(`detik`/`suara`/`viva`) on its fixture path for both stages of a crawl:

- **Discovery** (`adapter.discover()`) returns each adapter's small bundled/hardcoded
  fixture listing instead of fetching a live `/indeks` page.
- **Fetch** (`src/workers/lib/fetchHtml.js`'s `fetchArticleHtml()`, used by both
  `scripts/crawl-once.js` and the `crawl-fetch`/`crawl-parse` workers) reads that
  source's bundled `fixtures/<sourceId>/sample-article.html` instead of making an HTTP
  request — the URL passed in is ignored.

Set `CRAWL_LIVE=true` (in `.env` or the shell environment) to opt every pilot adapter
into real network requests for both discovery and fetch instead.

> **Caution:** only set `CRAWL_LIVE=true` against real, in-scope hosts
> (`detik.com`, `www.suara.com`, `www.viva.co.id`) and with a `CRAWLER_UA` that
> identifies this crawler honestly (see `.env.example`). It performs live HTTP requests
> against third-party sites, so treat it deliberately — e.g. don't leave it on in a
> `.env` that's shared/committed, and don't run it in a tight loop (respect the
> `crawl_interval_minutes`/`overlap_hours` in each adapter's source profile and the
> per-source rate limit in `src/queue/rateLimits.js`). It does not require or touch
> `DATABASE_URL`/Postgres by itself — it only changes where HTML comes from.
>
> **`CRAWL_LIVE=true` also requires an explicit `--limit`/`CRAWL_LIMIT`** — see
> "`--limit` / `CRAWL_LIMIT`" above — so a live run can never discover/process an
> unbounded number of URLs.

> **`beritasatu`/`tribunnews` are restricted, not fixture-first-only:** these two sources'
> edge WAF (CloudFront) 403s the plain `CRAWLER_UA` on live article fetch, so
> `fetchArticleHtml()` sends each adapter's own browser-class `LIVE_UA` for just these two
> (env-overridable via `BERITASATU_LIVE_UA`/`TRIBUNNEWS_LIVE_UA`) plus a small,
> env-overridable delay (`RESTRICTED_LIVE_FETCH_DELAY_MS`, default 800ms) before their live
> requests — every other source is unaffected. See `docs/RESTRICTED_UA_POLICY.md` for the
> full policy/rationale.

### Scheduling config (`src/sources/scheduleConfig.js`)

`src/sources/scheduleConfig.js` (Sprint 8, S8-B) is the config surface the repeatable-job
scheduler (`src/queue/scheduler.js` / `scripts/scheduler.js`, S8-A, below) reads to decide
what to schedule and how. It does **not** run anything itself. Env vars:

- **`SCHEDULE_SOURCES`** (required for the scheduler, comma-separated sourceIds, e.g.
  `detik,suara`) — explicit allow-list; unset means "schedule nothing", never "schedule
  everything enabled". Use `npm run schedule:all` for the full registry-derived list
  (does not force `CRAWL_LIVE`).
- **`SCHEDULE_INTERVAL_OVERRIDE_MINUTES`** (optional) — overrides every scheduled source's
  `crawl_interval_minutes` uniformly (e.g. for a short-interval staging soak test).
- **`SCHEDULE_DISCOVER_LIMIT`** (optional) — overrides `CRAWL_LIMIT` for scheduler-enqueued
  discover jobs specifically.

Discover jobs (scheduled or manual) also get an overlap window applied automatically
(`ctx.overlapHours`/`ctx.overlapCutoffAt`, from each source's own profile `overlap_hours` —
see `src/core/overlap.js` and playbook §20.2); `detik`/`suara` stop early once a listing item
is confidently older than the cutoff, falling back to the plain discover limit otherwise.

### Scheduling (`src/queue/scheduler.js` / `scripts/scheduler.js`)

Periodic discovery is implemented with BullMQ **job schedulers** (its current repeatable-job
API — the non-deprecated replacement for the older `repeat`/`removeRepeatable` calls) on the
existing `crawl-discover` queue. `scripts/scheduler.js` is a **short-lived CLI**: it reads
`SCHEDULE_SOURCES` (via `scheduleConfig.js`), upserts one job scheduler per schedulable source,
prints what it registered, and exits 0. It does not process any jobs itself — jobs the
schedulers create still flow through the normal `crawl-discover` worker, so the long-lived
worker process (`npm start`/`npm run dev`) must be running for scheduled discovery to actually
execute.

```bash
npm start                 # long-lived worker process; must be running to process scheduled jobs
npm run schedule          # registers/updates schedules for SCHEDULE_SOURCES and exits
npm run schedule:staging  # detik+suara @ 2m (Windows-safe)
npm run schedule:all      # all listAdapterIds() (Windows-safe; fixture-first, no CRAWL_LIVE)
```

Each scheduled source gets a stable job-scheduler id (`discover-schedule:<sourceId>`), so
re-running `npm run schedule` is idempotent: it **upserts** (updates in place, no duplicates)
rather than creating a second recurring job when config is unchanged. When `SCHEDULE_SOURCES`
shrinks or a source is dropped, the next `npm run schedule` run actively removes that source's
scheduler so it stops producing jobs — re-run it any time scheduling env vars change, or on
every deploy.

**Safety:** if `CRAWL_LIVE=true` and a source has no resolvable discover limit (neither
`SCHEDULE_DISCOVER_LIMIT` nor `CRAWL_LIMIT` set), that source is **not** registered — the CLI
logs a loud `scheduler_skip_unbounded_live` warning and skips it instead of creating a
recurring live-crawl job with no cap. Set `SCHEDULE_DISCOVER_LIMIT` (or `CRAWL_LIMIT`) to fix.
`npm run schedule:all` never forces `CRAWL_LIVE=true`; live full-registry runs still need an
explicit limit.

#### Staging runbook

Staging defaults to a short 2-minute interval for the two pilot sources so a soak test
produces observable activity quickly:

```bash
# .env (staging) — or export these in your shell before running the commands below
SCHEDULE_SOURCES=detik,suara
SCHEDULE_INTERVAL_OVERRIDE_MINUTES=2
# SCHEDULE_DISCOVER_LIMIT=2   # required in addition to the above if CRAWL_LIVE=true
```

```bash
npm run migrate
npm start &                # or run in a separate terminal/process manager; must stay running
npm run schedule:staging   # equivalent to: SCHEDULE_SOURCES=detik,suara SCHEDULE_INTERVAL_OVERRIDE_MINUTES=2 npm run schedule
```

`npm run schedule:staging` runs `scripts/schedule-staging.js`, which sets
`SCHEDULE_SOURCES=detik,suara` and `SCHEDULE_INTERVAL_OVERRIDE_MINUTES=2` in-process
(Windows PowerShell/`cmd.exe` and Unix alike) before calling the normal scheduler CLI.
Every 2 minutes thereafter, the worker process will pick up a fresh `discover` job for
`detik` and `suara` from the `crawl-discover` queue. To stop scheduling a source, remove it
from `SCHEDULE_SOURCES` and re-run `npm run schedule` (or `npm run schedule:staging`) — its
scheduler is removed on that next run.

#### Register all adapters (`schedule:all`)

Opt-in full allow-list from `listAdapterIds()` (currently 17 sources). Does **not** set
`CRAWL_LIVE` or force a short interval — profile cadences from `docs/SCHEDULE_PROFILES.md`
apply unless you override:

```bash
npm start                  # must stay running
npm run schedule:all       # fixture-first; registers every registered adapter id
# optional short soak (PowerShell):
#   $env:SCHEDULE_INTERVAL_OVERRIDE_MINUTES='2'; npm run schedule:all
# live (also need a limit): CRAWL_LIVE=true + SCHEDULE_DISCOVER_LIMIT (or CRAWL_LIMIT)
```

Unset `SCHEDULE_SOURCES` (and a plain `npm run schedule` with no allow-list) still schedules
nothing. Shrink back with a smaller allow-list or `schedule:staging`, then re-run.

### Run the full worker pipeline (needs Redis too)

```bash
npm run migrate
npm start                                   # or: npm run dev
node -e "require('./src/queue/enqueue').enqueueDiscover('detik')"   # or 'suara' / 'viva'
```

`crawl-discover` calls `adapter.discover()` (fixture URLs by default, per `CRAWL_LIVE`
above) and enqueues `crawl-fetch` jobs; `crawl-fetch` resolves the HTML via the same
`fetchArticleHtml()` used by `crawl:once` (fixture-first per source, live `axios` GET
only with `CRAWLER_UA` when `CRAWL_LIVE=true`) and enqueues `crawl-parse`; `crawl-parse`
runs the same `runPipeline` + store path as `crawl:once`. The per-source fetch delay
(`src/queue/rateLimits.js`) still applies before each `crawl-fetch` job runs, and
graceful shutdown (`SIGINT`/`SIGTERM`) is unchanged.

The same `--limit`/`CRAWL_LIMIT` rule from `crawl:once` applies to `crawl-discover` jobs:
pass a per-job limit via `enqueueDiscover(sourceId, { limit })`, or rely on the
`CRAWL_LIMIT` env var read by the worker process. It's required (the job fails) when
`CRAWL_LIVE=true`, e.g.:

```bash
CRAWL_LIVE=true CRAWL_LIMIT=2 npm start
node -e "require('./src/queue/enqueue').enqueueDiscover('detik', { limit: 2 })"
```

## Reporting (`npm run report` / `npm run report:check`)

One command, one daily/manual crawl report — no Redis required, only `DATABASE_URL`
(`src/metrics/report.js` has the query/format helpers; `scripts/crawl-report.js` is the CLI).
For a periodic health signal, use `npm run report:check` (same report + threshold exit codes;
see `src/metrics/health.js` / `scripts/report-check.js`).

```bash
npm run report
npm run report -- --since=24h
npm run report -- --since=24h --source=detik

npm run report:check                    # report + threshold evaluation
npm run report:check -- --since=24h
npm run smoke:report-check              # offline threshold unit smoke (no DB)
```

- **`--since`** (optional) — a duration string `<number><m|h|d|w>` (e.g. `30m`, `24h`, `7d`,
  `2w`). Falls back to the `REPORT_SINCE` env var, then defaults to `24h`.
- **`--source`** (optional) — filters every section to a single `source_id`.
- **`npm run report`** — prints a markdown report to stdout; exits `0` on success, `1` (with a
  clear message) if `DATABASE_URL` is unset, Postgres is unreachable, or a query fails.
- **`npm run report:check`** — same report, then evaluates thresholds and prints a summary on
  stderr. Exit `0` = healthy, `2` = threshold breach, `1` = infra/query error.
- Empty tables still print a valid report (each section shows "no activity in this window"
  instead of erroring). **Default thresholds do not false-alarm on an empty/idle DB.**

### Health thresholds (`report:check`)

| Env | Default | Behavior |
|---|---|---|
| `REPORT_PARSE_FAIL_MAX_RATIO` | `0.5` | Fail when `parse_fail / (stored+duplicate+parse_fail)` ≥ ratio |
| `REPORT_PARSE_FAIL_MIN_TOTAL` | `5` | Ratio check only applies when that denominator ≥ this |
| `REPORT_PARSE_FAIL_MAX_COUNT` | *(off)* | Optional absolute `parse_fail` cap |
| `REPORT_REQUIRE_STORED` | `0` | When `1`, require `stored+duplicate > 0` (alarms on idle) |
| `REPORT_MIN_DISCOVERIES` | `0` | When `>0`, fail if `discovered_urls ≥ N` but `stored+duplicate = 0` |

Always-on (no env): if `parse_fail > 0` and `stored+duplicate = 0`, exit `2` (pipeline only
produced failures). Empty window (all zeros) and in-progress-only windows stay exit `0`.

### Once vs periodically

```bash
# One-shot (local)
npm run report:check

# cron (hourly example — VPS-ready pattern; see docs/VPS_READY.md when present)
0 * * * * cd /path/to/egi-media-crawl && npm run report:check >> /var/log/egi-crawl-report.log 2>&1
```

Windows Task Scheduler: Action → Start a program → `npm` (or `npm.cmd`), arguments
`run report:check`, Start in = this repo directory. Schedule hourly/daily as needed.

The report has three sections:

1. **Funnel** — `stored` / `duplicate` / `parse_fail` (`invalid` + `dead_letter` only —
   `blocked`/`ignored_by_policy` are shown in their own columns, never silently lumped into
   `parse_fail`) per `source_id`, windowed on `processing_status.status_updated_at` (i.e.
   "state transitions that happened in the window", including re-crawls of older URLs, not
   just newly-discovered ones).
2. **Optional field fill %** — for `articles` touched in the window (windowed on
   `articles.last_seen_at`, bumped on every store pass), the % of rows with each optional
   N5 field (`src/core/fieldContract.js`'s `N5_OPTIONAL_FIELDS`, plus the soft-required
   `published_at`) actually filled in. Empty string / `null` / empty JSON array or object all
   count as not filled.
3. **`only_in_sitemap`** (optional section) — among `discovered_urls` touched in the window
   (windowed on `last_discovered_at`), how many normalized URLs were seen only via a
   sitemap-like channel (`discovery_channel ILIKE 'sitemap%'`) and never via a non-sitemap
   channel for the same `(source_id, normalized_url)`. Only meaningful for dual-channel
   sources — 0 is expected/valid otherwise.

To see non-zero numbers, run a fixture crawl for one or two sources first (no live network,
no Redis needed — see "Run the fixture crawl" above), then run the report:

```bash
npm run migrate
npm run crawl:once -- --source=detik
npm run crawl:once -- --source=suara
npm run report
npm run report:check
```

## Tech stack

- Node.js (CommonJS), aligned with `egi-media-backend`
- PostgreSQL via `pg`
- Redis + BullMQ for queueing
- `axios` for HTTP fetching
- `dotenv` for configuration
- Express + CORS for the **read-only** CMS API (`npm run api`)

### Read API (CMS / Next.js)

Lightweight Express server that exposes crawl rows without writing to the editorial DB:

```bash
npm run api          # http://localhost:5050
npm run api:dev      # nodemon
```

| Endpoint | Query |
|---|---|
| `GET /api/health` | — |
| `GET /api/crawled-articles` | `page`, `limit`, `source` (`detik` / `Detik` / …), `search` (title) |

CORS defaults: `http://localhost:3000`, `https://staging.egi-media.com` (override with `CORS_ORIGINS`).
Responses use the EGI read DTO aliases (`content`, `featured_image`, …) plus `article_id`.

## Project structure

```text
src/
  core/            shared crawler primitives (http, retry, rate limit, url normalize, validation, dedup)
  db/               database access layer
  metrics/          crawl report query + format helpers (report.js) + health thresholds (health.js)
  queue/            BullMQ queue definitions
  workers/          BullMQ worker processes / entrypoint
  sources/          source registry / source profiles
  adapters/         one folder per media adapter
    _template/      starting point for a new adapter
db/migrations/      SQL migrations
fixtures/           saved HTML/JSON fixtures for adapter tests
scripts/            operational scripts (migrate, crawl-once, crawl-report, report-check, etc.)
```

## Database migrations

```bash
npm run migrate
```

`scripts/migrate.js` applies every `.sql` file in `db/migrations/`, in filename order,
inside a transaction per file, and records each applied filename in a
`schema_migrations` table it creates on first run — so re-running `npm run migrate` at
any time is safe and only executes files it hasn't applied yet.

- `db/migrations/001_init.sql` — initial schema (`sources`, `discovered_urls`,
  `processing_status`, `articles`, `article_revisions`, ...).
- `db/migrations/002_add_summary_language_provenance.sql` — adds nullable `summary`,
  `language`, and `field_provenance` (JSONB) columns to `articles` as part of the N5
  normalized-field-contract (see `src/core/types.js` `ParsedArticle` typedef). This is
  required for the `suara`/`viva` pilot adapters, which populate `field_provenance`.
  **If you already have a database from before this migration existed, pull and re-run
  `npm run migrate`** before running the crawler again — `crawl:once`/the workers will
  still run without it, but `field_provenance`/`summary`/`language` will fail to persist
  (or be silently dropped, depending on your `src/db/articles.js` version) until it's
  applied.

## Environment setup

Day-to-day local stack: [`docs/LOCAL_STACK.md`](./docs/LOCAL_STACK.md).  
Future VPS cutover checklist (local-first, no remote deploy): [`docs/VPS_READY.md`](./docs/VPS_READY.md).

1. Copy `.env.example` to `.env` (or keep your existing `.env` — do not wipe secrets):

   ```bash
   cp .env.example .env
   ```

   Defaults match `docker-compose.yml`: Postgres **`localhost:5434`**
   (`egi`/`egi`/`egi_crawl`), Redis **`127.0.0.1:6379`**, `CRAWL_LIVE=false`.
   This is the crawl DB only — never the editorial `egi-postgres` on **5433**.

2. Bring up the local stack, migrate, then run the worker:

   ```bash
   npm install
   npm run stack:up    # postgres + redis (or: npm run dev:up  → up + wait healthy + migrate)
   npm run migrate     # skip if you used dev:up
   npm start           # long-lived worker
   ```

   Helpers: `npm run stack:ps`, `npm run stack:down` (keeps volumes). Optional
   schedules: `npm run schedule:staging` (detik+suara @ 2m) or `npm run schedule:all`
   (all adapters; fixture-first; worker must be running).

## Install & run

```bash
npm install
npm run stack:up                       # local crawl Postgres + Redis
npm run migrate                        # applies database migrations
npm run dev                            # run the worker in watch mode
npm start                              # run the worker
npm run crawl:once -- --source=detik   # one-off fixture crawl pass, no Redis needed
```

## Contributing a new source

Follow the onboarding process in `Reliable-News-Article-Scraping.md` (section 8): check robots/ToS, map the site, pick discovery channels, sample manually, write a source profile, add fixtures, shadow mode, then activate. Use `src/adapters/_template` as the starting point once adapters are implemented (F5).
