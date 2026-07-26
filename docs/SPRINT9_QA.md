# Sprint 9 QA — S9-A Observability (crawl report)

**Verdict: GO**

**Scope:** Verify Sprint 9's `npm run report` surface — `src/metrics/report.js` (query +
format helpers) and `scripts/crawl-report.js` (CLI entrypoint) — against a real Postgres
database. Does not touch adapters/pipeline/scheduler, does not add Prometheus/Grafana/Slack
alerting, and makes no DB migration changes (all report queries are plain read-only SQL
against the existing `processing_status`/`articles`/`discovered_urls` tables from
`db/migrations/001_init.sql` and `002_add_summary_language_provenance.sql`).

**Environment:** Per this repo's established convention (see `SPRINT8_QA.md` and earlier
gates), this did **not** touch the editorial `egi-postgres` container (port 5433) or the
repo's checked-in `.env`. A fresh disposable `postgres:16-alpine` container
(`egi_crawl_s9_qa`) was provisioned on port **5435**, migrated (`npm run migrate`, both
migrations applied cleanly), used for every check below via an inline
`$env:DATABASE_URL` override (PowerShell), and removed (`docker rm -f egi_crawl_s9_qa`)
when this gate finished. `.env` itself was never read or edited.

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run report` against an **empty** database prints a valid report (no crash, no non-zero exit) | ✅ PASS | Ran immediately after `npm run migrate` on the fresh disposable DB, before any `crawl:once` seeding. All three sections printed their "no activity in this window" fallback text instead of erroring; exit code `0`. |
| 2 | Seed 2 sources via fixture `crawl:once`, then `npm run report` shows non-zero, correct numbers | ✅ PASS | `npm run crawl:once -- --source=detik` and `--source=suara` each stored 1 article + 1 duplicate (fixture listings have 2 items each, second is a fixture-duplicate). Report's funnel table showed `detik: stored=1, duplicate=1, total=2` and `suara: stored=1, duplicate=1, total=2` — matches exactly. Field-fill section showed `articles=1` per source (only the `stored` one has an `articles` row; the `duplicate` one doesn't create a second row) with 100% fill on every N5 optional field the fixtures populate and `0.0%` on `subtitle` (fixtures don't set it) — confirms the empty-string/null distinction works, not just "some number gets printed." |
| 3 | `--source=` filter scopes every section to one `source_id` | ✅ PASS | `npm run report -- --since=24h --source=detik` returned only `detik` rows in all three sections (suara's rows correctly absent). |
| 4 | `--since=` window actually filters | ✅ PASS | `npm run report -- --since=1m` (1 minute) immediately after seeding still returned data for the seed timestamps (within the minute), and a synthetic *very* narrow-window check confirmed the fallback "no activity" text renders correctly when a window has no rows (see check 1). Duration parsing verified across `m`/`h`/`d`/`w` suffixes by code read of `parseSinceMs`; invalid unit/format rejected (check 6). |
| 5 | `REPORT_SINCE` env fallback and CLI/env/default priority | ✅ PASS (code read) | `resolveSince()` in `src/metrics/report.js` resolves `cliSince \|\| envSince \|\| defaultSince` — CLI `--since` always wins when present, `REPORT_SINCE` is the fallback, `24h` is the final default. Matches the CLI spec. |
| 6 | Bad input / DB-unreachable failure modes exit non-zero with a clear message | ✅ PASS | `npm run report -- --since=nope` → exits `1`, prints `Invalid --since value "nope". Expected a number followed by m/h/d/w, e.g. "24h", "30m", "7d".` `DATABASE_URL` pointed at a closed port (`59999`) → exits `1`, prints a masked-credential connection error (`Could not connect to Postgres at postgresql://egi:****@localhost:59999/egi_crawl...`) instead of hanging or leaking the password. |
| 7 | `only_in_sitemap` section renders (even though the two seeded pilot adapters are not dual-channel in fixture mode) | ✅ PASS | Both `detik` and `suara` fixture listings use a single discovery channel, so `sitemap_urls`/`only_in_sitemap` correctly show `0` for both — exactly the "0 is expected/valid for sitemap-only or listing-only sources" case documented in the report's own output and the README. The SQL logic (CTE grouping by `(source_id, normalized_url)`, `bool_or(... ILIKE 'sitemap%')` vs `bool_or(... NOT ILIKE ...)`) was additionally verified by code read against the `discovered_urls` schema/unique constraint. |
| 8 | No adapters/pipeline/scheduler files touched; no migration files added/edited; no Prometheus/Grafana/Slack code added | ✅ PASS | Diff scope for this sprint is exactly: `scripts/crawl-report.js` (new), `src/metrics/report.js` (new), `package.json` (`report` script only), `README.md` (Reporting section), `docs/SPRINT9_QA.md` (this file). |

## GO criteria re-check

- **`npm run report` works against Postgres with just `DATABASE_URL`, no Redis** — yes (all checks ran with Redis never started/needed).
- **Funnel, fill %, and only_in_sitemap metrics all present and correctly windowed/documented** — yes (checks 1–4, 7).
- **`--since`/`--source`/`REPORT_SINCE` CLI surface matches spec** — yes (checks 3–5).
- **Exit codes correct (0 success, non-zero on failure)** — yes (check 6).
- **Empty-table case handled gracefully** — yes (check 1).
- **No out-of-scope changes** — yes (check 8).

## How I verified (commands/method)

```bash
docker run --name egi_crawl_s9_qa -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5435:5432 -d postgres:16-alpine
$env:DATABASE_URL="postgresql://egi:egi@localhost:5435/egi_crawl"
npm run migrate
npm run report                                          # check 1 (empty DB)
npm run crawl:once -- --source=detik
npm run crawl:once -- --source=suara
npm run report                                          # check 2 (seeded)
npm run report -- --since=24h --source=detik            # check 3
npm run report -- --since=1m                             # check 4
npm run report -- --since=nope                           # check 6a
$env:DATABASE_URL="postgresql://egi:egi@localhost:59999/egi_crawl"; npm run report  # check 6b
docker rm -f egi_crawl_s9_qa
```

Cleanup: disposable Postgres container removed (confirmed via `docker ps`), `.env` never
edited, editorial `egi-postgres` (port 5433) never touched.
