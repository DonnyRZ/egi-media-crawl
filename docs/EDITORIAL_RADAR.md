# Editorial Radar candidate

The candidate is local-only until a coordinated release is requested. Legacy `/viral` and its aggregation snapshots remain available. No automatic CMS article publication or homepage Trending placement is introduced.

## Source enrollment

`config/radar-sources.json` is an explicit, versioned registry. It currently enrolls 12 sources observed producing live data during the read-only production audit and verified reachable from the local network. Five other adapters are paused with reasons. There is no required portal count.

Official Liputan6 Politics, Business, Technology, Sports and Entertainment listings were validated separately. Other channels declare incomplete desk coverage instead of claiming all desks. The local validation report is `reports/radar-source-validation.json`.

An HTTP/listing success proves reachability, not exhaustiveness. Only a verified overlap boundary or explicit adapter exhaustion can set `complete=true`. Budget exhaustion, unsupported deeper paging, missing publication dates and failed channels remain visible. Paused sources are skipped by the candidate scheduler and worker; transient failures never remove an active source from the denominator.

Known groups are configured using first-party references: [Detik Network/Transmedia](https://www.detik.com/sumut/berita/d-7453944/trans-media-dukung-pengembangan-sumut-lewat-apresiasi), [KLY services](https://www.kly.id/service), and [MNC company profile](https://www.mncdigital.com/microcontact/mnc-pictures). The registry records those references and the check date. Unverified ownership of remaining outlets is flagged and cannot supply an additional independent-group vote. Ownership/channel review must be confirmed before promotion. Registry changes alter the cohort hash and invalidate an old promotion report.

To add a source: keep it paused, verify official HTTPS channels, publication dates, parser compatibility and desk coverage using read-only probes; record ownership and enrollment time; then explicitly activate it. Do not use a sitemap `lastmod` as publication time or bypass source restrictions.

## Method

- Eligible article time is original publication time, falling back to immutable first discovery for full articles without a publication date. Metadata-only observations require an actual publication hint from an official listing.
- Normalize title, summary and up to 800 characters of lead text. Keep short acronyms and numbers; retain popular terms. Alias/rule matching is deterministic and does not call AI.
- Parent events preserve institution/action angles. Ambiguous matches remain separate. Candidate matching uses evolving representatives rather than only the first headline.
- Canonical source/URL duplicates do not add articles. Each portal/group has one breadth vote. Identical full-text hashes or normalized long leads are conservative copy indicators, not a definitive syndication attribution; copies do not add independent votes. Matching headlines without body evidence are not enough to declare a copy.
- Score = 100 × (0.50 breadth + 0.30 momentum + 0.20 freshness). Breadth averages log-normalized unique portals and verified groups against the enrolled cohort. Momentum compares new group coverage in two six-hour windows. Freshness has a 12-hour half-life.
- Momentum requires continuous healthy, complete channel checks for the same cohort over the last 12 hours. Backfill over two hours late and pre-enrollment observations cannot create a burst. Initial/cohort-changed runs therefore have limited momentum evidence.
- Primary recommendations need at least three independent portals across two verified groups. Two verified groups with new comparable coverage can become emerging candidates. Confidence is an evidence label, not an accuracy probability.

The method is a candidate. Its real precision/recall are **not measured yet**; offline tests and synthetic load do not establish editorial usefulness.

## Storage and compatibility

Apply additive migrations `004_editorial_radar.sql` and `005_radar_storage_compaction.sql` to an isolated local database first using `npm run migrate`. They add observations, source health, versioned cohorts, runs, persistent event memberships, parent snapshots and compact membership fields. Existing article IDs, contents, statuses and legacy event tables are preserved.

Inputs are read without a pre-selection 10,000-row limit, under repeatable read and a wall-clock anchor shared across windows. Runs use a PostgreSQL advisory lock. Candidate failure is audited without preventing the legacy worker from refreshing. Bulk inserts publish an atomic snapshot. CMS event details and snapshots keep only the latest 24 succeeded runs per window (about six hours at the default 15-minute cadence); lightweight run metadata remains for 30 days for shadow-evaluation history. New membership rows store scalar fields instead of duplicate JSON payloads; legacy rows remain readable until retention removes them. Raw Crawl articles and observations are not deleted by candidate retention. Cleanup is bounded to 50,000 rows per table per run and is attempted after every non-dry-run attempt, including a failed aggregation.

Successful HTTP fetches are cached in Redis for one hour, bounded at 4 MiB per page, and referenced by `fetchId` in parse jobs. Parse consumes that response rather than downloading again. Expired cache schedules an explicitly recorded new fetch. Fetch outcomes are written to `fetch_attempts` and processing status; blocked/nonretryable responses fail with `UnrecoverableError`, while network/429/5xx use the queue's bounded exponential retries. Rediscovery uses processing state rather than refreshing a seen-time lock forever.

## API

All new backend routes require the existing CMS `author` or `superadmin` authentication. Direct Crawl candidate routes require loopback access, or `CRAWL_API_TOKEN` configured identically on Crawl and backend.

`GET /api/v1/news-feed/recommendations`

Parameters: `window_hours=24|72|168` (default 24), `page` (default 1), `limit` (default 20, max 100), `search`, `category=business|technology|politics|sports|entertainment|other`, `trend=rising|steady|falling`, `engine=candidate` for explicit shadow preview.

Envelope remains `{success,data,message,code}`. Data contains `items`, `page`, `limit`, `total`, `total_pages`, and `meta`. List items include persistent ID, full headline, counts, score/components, trend, confidence, evidence quality, reasons, angles and a bounded timeline. Member articles are hydrated only in detail. Legacy mode also now searches and paginates in SQL before member hydration.

`GET /api/v1/news-feed/recommendations/:id`

Accepts `window_hours`, `page`, `limit`, and optional `run_id` to pin the snapshot during drawer interaction. Returns `item` plus source-article pagination. `listing_only` source evidence is explicitly marked.

`GET /api/v1/news-feed/status`

Returns source configuration/paused reasons, channel health/completeness, latest runs, fetch outcomes and outstanding processing states. Snapshot metadata differentiates `warming_up`, `ready`, `degraded`, and `stale` (more than 30 minutes old); eligible and processed input counts are separate. Database errors remain errors, never successful empty catalogues.

## CMS behavior

Viral is presented as an editorial issue radar. Existing method is initially selected; candidate preview is explicitly labeled as evaluation. Search/pagination are server-side. Data refreshes every 60 seconds while visible, on focus and reconnect, never in a hidden tab. Failed refresh retains successful data and offers retry. Source state, data age and method are visible. The drawer pins its clicked snapshot, keeps complete headlines and has keyboard focus containment/restoration.

## Local commands and rollout gates

1. Preserve the existing dirty production Crawl checkout before any future release; do not reset it to local HEAD. No VPS files were changed during this implementation.
2. Configure isolated PostgreSQL/Redis; apply migrations; set `RADAR_ENABLED=true`, keep `RADAR_SERVE_CANDIDATE=false`.
3. Run the existing Crawl/aggregation workers. Candidate snapshots are persisted alongside legacy snapshots. `npm run radar:once -- --dry-run` computes without writing candidate rows; `npm run radar:once` persists a local run.
4. `npm run radar:validate` probes enrolled official channels read-only. Update enrollment deliberately; temporary failures are reported, not silently removed.
5. `npm run radar:benchmark -- <directory>` exports actual candidate evidence with blank independent reviewer labels. It requires at least 500 pairs and 100 events across the five desks; insufficient data remains explicitly incomplete. Do not substitute synthetic fixtures for this benchmark.
6. Two different reviewers annotate every pair/event and the top ten independently; resolve disagreements. Record `reviewers` and `sourceCoverageReviewed` in the review file. `npm run radar:evaluate -- <review.json> <approval.json>` computes metrics and checks the same-cohort seven-day history.
7. Promotion requires precision ≥95%, recall ≥85%, ≥8 useful top-ten recommendations, at least 500 reviewed pairs/100 reviewed events, two reviewer identities, confirmed source coverage, and ≥168 hours of complete shadow processing. Set `RADAR_APPROVAL_FILE` and `RADAR_SERVE_CANDIDATE=true` only after acceptance; otherwise the default remains legacy.
8. Roll back recommendation selection by setting `RADAR_SERVE_CANDIDATE=false`. Keep additive schema and newly collected evidence. Deployment needs a separately requested release with backups and browser/service checks.

Run `npm run test:radar`, existing aggregation/worker smokes, and `npm run radar:perf`. The additional PostgreSQL integration harness under workspace `ops/radar-validation/integration.cjs` uses PGlite in memory and never connects to VPS.
