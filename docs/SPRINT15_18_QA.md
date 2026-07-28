# S15-S18 News Event Aggregation QA

## Scope

This QA record covers only `egi-media-crawl`. No CMS, AI backend, frontend, or
editorial database is changed by the feature.

## Implemented

- S15 contract: `docs/NEWS_EVENT_CONTRACT.md`
- S15 migration: `db/migrations/003_news_event_aggregation.sql`
- S15 feature flags in `.env.example`
- S16 pure engine under `src/event-aggregation/`
- S17 derived repository: `src/db/newsEvents.js`
- S17 dedicated BullMQ queue: `crawl-event-aggregation`
- S17 worker handler: `src/workers/handlers/eventAggregation.js`
- S17 commands: `event:once`, `event:schedule`, `event:replay`
- S17 Redis queue smoke: `crawl-event-aggregation` processes a dry-run job
- S18 smoke/replay tests and this QA record

## Local evidence

| Check | Result |
|---|---|
| `npm run smoke:event-aggregation` | PASS |
| `npm run smoke:event-worker` | PASS |
| Existing rate-limit smoke | PASS |
| Existing overlap/date smoke | PASS |
| Existing EGI read DTO smoke | PASS |
| Existing health/report smoke | PASS |
| `node --check` on new DB/worker/engine modules | PASS |
| Dependency audit after `npm ci --ignore-scripts` | 0 vulnerabilities |
| Local Postgres migration 001-003 | PASS |
| Local Postgres schema integration smoke | PASS |
| Local Postgres persist + idempotency smoke | PASS; fixture cleaned |
| Local Redis/BullMQ queue smoke | PASS; dry-run job processed |

The event replay smoke verifies that two media reporting “Korupsi X” form one
event, while “Tarif Trump” and “Perang Negara X dan Y” remain separate. It also
verifies deterministic output and same-source duplicate handling.

The saved VPS simulation snapshot was replayed locally through the new engine:

| Window | Articles | Events | Events with 3+ media |
|---|---:|---:|---:|
| 24 hours | 2,669 | 340 | 121 |
| 72 hours | 4,362 | 576 | 217 |
| 7 days | 4,362 | 576 | 217 |

Manual audit of 20 selected events (largest coverage, lowest average match
score, and ambiguous anchors) found 15 clearly coherent events, 5 that are
coherent as one event family but contain different follow-up angles, and no
obviously unrelated merge in the inspected sample. The five borderline cases
are intentionally retained as coverage events; a future editorial “angle” layer
can split them without changing the cross-media event count.

Replay performance on the same VPS snapshot:

| Window | Elapsed | Peak observed RSS |
|---|---:|---:|
| 24 hours | 4.36 s | 97 MB |
| 72 hours | 9.76 s | 130 MB |
| 7 days | 9.65 s | 206 MB |

The observed RSS stays below the initial ~300 MB additional-worker target for
this 4,362-article replay. This is a local process measurement, not a promise
about the full production worker baseline.

## Production-data replay

`scripts/event-aggregation-replay.js` accepts either a plain article array or the
saved simulation object containing an `articles` array. It reads the data and
writes only a local JSON result. It does not connect to or write to a database.

## Environment limitation

The local Docker daemon required elevated access before the integration check,
but the local Postgres/Redis stack was then started and migration `001`-`003`
was applied successfully. The persist/idempotency smoke wrote two temporary
articles and one event, reran the same aggregation, verified one event with two
members, and confirmed the fixture cleanup left zero test sources. A full live
BullMQ production worker process was not started; the dedicated event queue was
verified with a real local Redis worker in dry-run mode.

## Safety gates before enabling

1. Apply migration `003_news_event_aggregation.sql` to a disposable local
   `egi_crawl` database.
2. Run `npm run event:replay` against the VPS snapshot and manually inspect the
   largest, lowest-score, and ambiguous-anchor events.
3. Start Redis and the worker with `EVENT_AGGREGATION_ENABLED=true` and
   `EVENT_AGGREGATION_DRY_RUN=true`.
4. Compare dry-run counts and memory before setting dry-run false.
5. Enable persisted derived snapshots only after replay/audit approval.
