# Sprint 14 QA — S14-C Quality Gate

**Verdict: GO**

**Scope:** Final gate for the local “VPS-ready” track. Verify S14-A (`report:check` /
`smoke:report-check` + thresholds) and S14-B (`docs/VPS_READY.md` runbook + local
deployment-ready tick list + README / LOCAL_STACK links). Walk the local tick list for
real. LOCAL only. No VPS deploy. No feature rewrites (no blocker found).

**Environment:** Compose already healthy (`egi-crawl-postgres` on `127.0.0.1:5434`,
`egi-crawl-redis` on `127.0.0.1:6379`). Editorial `:5433` not used as crawl DB
(`docker-compose.yml` binds only 5434/6379). Fixture-first (`CRAWL_LIVE` unset/false).

Prior gates that this runbook rests on: [SPRINT11_QA.md](./SPRINT11_QA.md) (compose +
DX), [SPRINT12_QA.md](./SPRINT12_QA.md) (profiles + `schedule:all`),
[SPRINT13_QA.md](./SPRINT13_QA.md) (overlap parse, graceful shutdown, light watermark).

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run smoke:report-check` → PASS | ✅ PASS | Exit 0; `[health smoke] PASS` (offline threshold unit smoke, no DB). |
| 2 | Stack healthy: `npm run stack:ps` — postgres 5434 + redis 6379; editorial 5433 unused | ✅ PASS | `egi-crawl-postgres` Up (healthy) `127.0.0.1:5434->5432/tcp`; `egi-crawl-redis` Up (healthy) `127.0.0.1:6379->6379/tcp`. Compose comments + ports confirm no 5433 bind. |
| 3 | `npm run migrate` OK | ✅ PASS | Exit 0; `[migrate] up to date (2 migration(s) already applied)`. |
| 4 | Idle/fresh: `npm run report:check` → exit 0 | ✅ PASS | Exit 0; `[report-check] OK`. Window totals: `stored=0 duplicate=46 parse_fail=0 discovered_urls=78 terminal=46 success=46`. Thresholds: `parseFailMaxRatio=0.5 parseFailMinTotal=5 parseFailMaxCount=(off) requireStored=0 minDiscoveries=0`. |
| 5 | Optional: `crawl:once --source=detik --limit=1` then `report:check` → exit 0 | ✅ PASS | Fixture crawl exit 0; discovered 1 URL → `duplicate (duplicate_content)`; summary `1/1 article(s) stored/deduped`. Post-run `report:check` exit 0 (`[report-check] OK`). |
| 6 | `docs/VPS_READY.md` exists; checklist scripts match `package.json` | ✅ PASS | File present. Scripts cited (`stack:*`, `dev:up`, `schedule:all`, `smoke:shutdown`, `report:check`, `smoke:report-check`, `migrate`, `crawl:once`, `schedule` / `schedule:staging`) all exist in `package.json`. Process model (compose infra + host Node worker) matches compose + README. |
| 7 | Out-of-scope: no actual deploy / no editorial sync | ✅ PASS | § “Belum dilakukan / out of scope” explicitly lists no VPS provision/SSH/remote deploy, no TLS/DNS/firewall, no systemd installed, **no editorial DB sync** (5433 unrelated), no CMS pipeline, no production secrets, no offsite backup automation, no full live 17-source deploy gate, no Dockerized worker. |
| 8 | README points to VPS_READY | ✅ PASS | Environment setup: link to [`docs/VPS_READY.md`](./VPS_READY.md) (“Future VPS cutover checklist … no remote deploy”). Reporting section references VPS_READY cron pattern. `LOCAL_STACK.md` also links VPS_READY as the full deployment-ready checklist. |

## GO criteria re-check

- **S14-A report health** — yes; offline smoke PASS; live `report:check` exit 0 idle and after fixture crawl.
- **S14-B VPS_READY runbook** — yes; full process order, env table, compose ports, schedule wrappers, graceful restart, backup sketch, systemd examples (illustrative only), out-of-scope, local tick list.
- **Script accuracy** — yes; every npm script named in the local tick list / recommended process order exists in `package.json`.
- **No feature rewrite** — yes; docs-only gate; no code changes required.
- **Sprint 11–14 local track** — **complete**. Compose/DX (11) → profiles/`schedule:all` (12) → overlap/shutdown/watermark (13) → report health + VPS-shaped runbook (14) are all gated GO locally. Actual remote host bring-up is explicitly deferred.

→ **GO**

## Out of scope (confirmed not touched this gate)

- No VPS provision, SSH, TLS, DNS, firewall, reverse proxy, or remote deploy.
- No systemd (or other process manager) installed on a server.
- No editorial DB sync / write path (port **5433**).
- No feature/code rewrites (S14-C is docs + verification only).

## Residuals / follow-ups — future deploy only

1. **Actual VPS cutover** — provision host, copy env (non-compose secrets), install Node, bring up compose (or equivalent Postgres/Redis), migrate, `npm start`, register schedules, wire cron/Task Scheduler for `report:check`.
2. **TLS / DNS / firewall / reverse proxy** — not claimed; required for any public-facing ops surface later.
3. **systemd (or equivalent) install** — unit snippets in `VPS_READY.md` are examples only; install + timer units remain a later pass.
4. **Offsite backup / restore drill** — high-level `pg_dump` sketch exists; automated retention and restore runbook not done.
5. **Editorial sync / CMS pipeline** — intentionally out of scope for the crawl service; still no write path to `:5433`.
6. **Sustained live full-registry soak** — not a Sprint 14 deploy gate; live still requires explicit limits + restricted-UA policy.
7. **Carry-over (non-blocking) from S11–S13:** orphan host Redis must stay off `:6379`; fixture listing dates vs short `overlap_hours`; light watermark ≠ full playbook §20.4; live detik indeks still lacks per-item timestamps; `discover_job_done` omits `skippedSeen` in structured logs.

## How I verified

```bash
npm run smoke:report-check
npm run stack:ps
npm run migrate
npm run report:check
npm run crawl:once -- --source=detik --limit=1
npm run report:check
# docs: VPS_READY.md out-of-scope + checklist vs package.json; README + LOCAL_STACK links
```

## Files written (S14-C)

- `docs/SPRINT14_QA.md` — this gate
