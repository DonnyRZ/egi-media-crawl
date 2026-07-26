# DB Verify Report (V1)

**Scope:** Prove the Postgres store path (migrate -> crawl:once x2 -> idempotency -> thumbnail_url) for `detik`, `suara`, `viva` on a dedicated `egi_crawl` database. Fixture path only (`CRAWL_LIVE` unset/false), per constraints.

## Environment

- `.env` created from `.env.example`. `DATABASE_URL` set to a **disposable Docker Postgres container** (see Blockers) - never pointed at the editorial EGI app database.
- `CRAWL_LIVE=false` (fixture path, as shipped in `.env.example`).
- `DATABASE_URL=postgresql://egi:egi@localhost:5434/egi_crawl` (container `egi_crawl_verify`, `postgres:16-alpine`, port `5434`).

## migrate

- `npm install` - already up to date (0 changes).
- `npm run migrate` - **success**. Applied, in order, inside the `schema_migrations` bookkeeping table:
  - `001_init.sql`
  - `002_add_summary_language_provenance.sql`
- 2/2 migrations applied cleanly on first run against the fresh `egi_crawl` DB.

## per_source

| source | run1 | run2 | rows | has_thumbnail | notes |
|--------|------|------|------|----------------|-------|
| detik  | 1 stored, 1 duplicate (2 discovered) | 2/2 duplicate, 0 stored | 1 | 1/1 | 2nd fixture URL resolves to identical `content_hash` as the 1st -> correctly deduped by content, not just URL |
| suara  | 1 stored, 1 duplicate (2 discovered) | 2/2 duplicate, 0 stored | 1 | 1/1 | same pattern as detik (multipage variant + a 2nd listing URL share one fixture's content) |
| viva   | 1 stored, 7 duplicate (8 discovered) | 8/8 duplicate, 0 stored | 1 | 1/1 | `indeks.html` fixture yields 8 candidate URLs, but only one `sample-article.html` fixture backs the fetch step, so all 8 resolve to the same `content_hash` |

Sample stored rows (one per source, from `SELECT ... FROM articles`):

| source_id | canonical_url | has_thumb | published_at |
|---|---|---|---|
| detik | `.../berita/d-1234567/contoh-judul-berita-detik` | true | 2026-07-23 07:35:00+00 |
| suara | `.../news/2026/07/24/070859/contoh-judul-berita-suara-multipage` | true | 2026-07-24 00:08:59+00 |
| viva | `.../berita/1234561-menteri-luncurkan-program-ketahanan-pangan-nasional` | true | 2026-07-23 23:10:00+00 |

## idempotency

- **Schema-level guarantee**: `articles_source_id_canonical_url_key` is a `UNIQUE (source_id, canonical_url)` btree constraint on `articles` - structurally prevents duplicate rows for the same source+URL, not just an app-level check.
- **Observed behavior**: running `crawl:once` a 2nd time for each source produced **0 new rows** and **100% `duplicate (duplicate_content)`** results for every discovered URL, for all 3 sources.
- **Row counts after 2 runs each**: `articles` has exactly **1 row per source_id** (detik=1, suara=1, viva=1) - no growth between run 1 and run 2.
- **discovered_urls bookkeeping** is also idempotent: counts stayed at detik=2, suara=2, viva=8 after the 2nd run (matching each `discover()` call's candidate count, not doubled).
- Conclusion: **idempotency confirmed** at both the application (content-hash dedup) and database (unique constraint) layers.

## thumbnail_conclusion

- **3/3 sources have thumbnail_url populated** on their one stored fixture row: detik 1/1, suara 1/1, viva 1/1 (all non-null, well-formed CDN image URLs).
- No adapter/fixture bug found on the fixture path - thumbnails extract and persist correctly for all three pilot sources. No adapter fix was needed.

## go_no_go_store

**GO.** The fixture path (source of truth per verification constraints) proves the full store path end-to-end on Postgres for `detik`, `suara`, and `viva`: migrations apply cleanly, `crawl:once` stores new articles and correctly identifies duplicates on re-run (both via content-hash logic and a DB-level unique constraint), and `thumbnail_url` is populated for every stored row across all three sources.

## blockers

- No local (non-Docker) Postgres was available on the host, and Docker Desktop was not initially running. Started Docker Desktop, then provisioned a **disposable** container `egi_crawl_verify` (`postgres:16-alpine`, port `5434`, db `egi_crawl`, user/pass `egi`/`egi`) rather than reuse the host's existing `egi-postgres` (port 5433) or `orviko-postgres` (port 5432) containers, to guarantee the editorial EGI app database was never touched. This container was **removed after verification** (see Cleanup).
- **Live crawl step (optional, Step 5) was skipped.** `scripts/crawl-once.js` has no `--limit`/max-articles flag, and with `CRAWL_LIVE=true` each source's `adapter.discover()` would hit the live indeks/listing page and return every URL it finds (viva's fixture-analog alone yields 8) with no cap mechanism to fetch only 1-2 articles. Enabling live mode as-is risks fetching many live pages per source in one run, which conflicts with "do not hammer sites." Since the fixture path (source of truth for go/no-go) is fully green, live verification was treated as bonus and skipped rather than risking a live overfetch.
- No adapter or fixture code was modified. No files under `docs/target-sites.md` or any playbook were touched.

## Cleanup

- Disposable container `egi_crawl_verify` was stopped and removed: `docker rm -f egi_crawl_verify`.
- Local `.env` in this repo still contains `DATABASE_URL=postgresql://egi:egi@localhost:5434/egi_crawl` pointing at that now-removed container; recreate it with:

  ```bash
  docker run --name egi_crawl_verify -e POSTGRES_USER=egi -e POSTGRES_PASSWORD=egi -e POSTGRES_DB=egi_crawl -p 5434:5432 -d postgres:16-alpine
  npm run migrate
  ```
