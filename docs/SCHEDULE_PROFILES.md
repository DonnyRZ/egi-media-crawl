# Schedule profiles (Sprint 12 / S12-A)

Per-source discover cadence defaults exposed by each adapter's `getSourceProfile()`
(`crawlIntervalMinutes` / `overlapHours` in the raw adapter; bridged to
`crawl_interval_minutes` / `overlap_hours` by each `coreAdapter.js`).

`src/sources/scheduleConfig.js` reads these via the registry
(`profile.crawl_interval_minutes ?? profile.crawlIntervalMinutes`, same for overlap).
Discover job **limit** is still env-driven (`SCHEDULE_DISCOVER_LIMIT` / `CRAWL_LIMIT`),
not a profile field — adapter-internal `DEFAULT_DISCOVER_LIMIT` (usually 8) only applies
when no job/env limit is passed.

## Defaults table

| sourceId          | intervalMinutes | overlapHours | tier |
| ----------------- | --------------: | -----------: | ---- |
| `detik`           |              15 |            2 | A — wire / staging keep |
| `suara`           |              15 |            2 | A — wire / staging keep |
| `viva`            |              20 |            3 | B — high-volume national |
| `cnn_indonesia`   |              20 |            3 | B — high-volume national |
| `liputan6`        |              20 |            3 | B — high-volume national |
| `kumparan`        |              20 |            3 | B — high-volume national |
| `okezone`         |              20 |            3 | B — high-volume national |
| `sindonews`       |              20 |            3 | B — high-volume national |
| `tempo`           |              30 |            4 | C — mid / editorial |
| `tirto`           |              30 |            4 | C — mid / editorial |
| `jawa_pos`        |              30 |            4 | C — mid / editorial |
| `idn_times`       |              30 |            4 | C — mid / editorial |
| `republika`       |              30 |            4 | C — mid / editorial |
| `media_indonesia` |              30 |            4 | C — mid / editorial |
| `merdeka`         |              30 |            4 | C — mid / editorial |
| `beritasatu`      |              60 |            6 | D — restricted UA |
| `tribunnews`      |              60 |            6 | D — restricted UA |

## Rationale

- **Tier A** keeps the Sprint 8 staging soak values (`15m` / `2h`) for `detik`/`suara`.
- **Tier B** slightly slows high-churn nationals so a full 17-source schedule is less chatty
  than every source at 15m, while staying inside the 15–60m band.
- **Tier C** uses a longer overlap (4h) for mid-volume / more editorial outlets where a
  missed run is likelier to leave a gap than raw wire volume.
- **Tier D** (`beritasatu`/`tribunnews`) is deliberately conservative: CloudFront WAF +
  browser-class UA (see `docs/RESTRICTED_UA_POLICY.md`). Longer interval and a 6h overlap
  reduce live pressure while still covering missed cycles.

## Overrides (ops)

- `SCHEDULE_INTERVAL_OVERRIDE_MINUTES` — uniform interval override for soak tests.
- `SCHEDULE_SOURCES` — allow-list (unset → schedule nothing). Prefer npm wrappers:
  - `npm run schedule:staging` — `detik,suara` @ 2m
  - `npm run schedule:all` — full registry list from `listAdapterIds()` (does not force
    `CRAWL_LIVE`; set `SCHEDULE_INTERVAL_OVERRIDE_MINUTES` separately for a short soak)
- Rate delay derivation from these intervals: S12-B (`src/queue/rateLimits.js`).

## Where to edit

Change values only in `src/adapters/<sourceId>/index.js` → `getSourceProfile()`.
Do not duplicate literals in `coreAdapter.js` (it re-exports from the raw profile).
