# Sprint 1 Smoke (Live) Raw Evidence

**Agent:** Sprint 1 Agent S1-B (Smoke live executor)
**Scope:** Live crawl -> Postgres for `detik`, `suara`, `viva` with `--limit=2`, run twice each,
to capture field-fill and idempotency evidence for S1-C's QA verdict. No GO/NO-GO verdict is
recorded here (S1-C).

## Environment

- Disposable Docker Postgres container `egi_crawl_qa` (`postgres:16-alpine`, host port `5435`,
  db `egi_crawl`, user/pass `egi`/`egi`) created for this session. **Not** the editorial
  `egi-postgres` container (port 5433) - that was left untouched throughout.
- `.env`'s `DATABASE_URL` already pointed at `postgresql://egi:egi@localhost:5435/egi_crawl`
  (matching convention from prior Sprint 0 QA), so no `.env` edit was needed.
- `npm run migrate` applied `001_init.sql` and `002_add_summary_language_provenance.sql` cleanly
  (2/2 applied, fresh DB).
- No adapter, core, README, `.env.example`, or `target-sites.md`/playbook files were modified.

## Commands run (verbatim, one source at a time, polite ~3s gap between runs)

```
CRAWL_LIVE=true npm run crawl:once -- --source=detik --limit=2   (run 1)
CRAWL_LIVE=true npm run crawl:once -- --source=detik --limit=2   (run 2)
CRAWL_LIVE=true npm run crawl:once -- --source=suara --limit=2   (run 1)
CRAWL_LIVE=true npm run crawl:once -- --source=suara --limit=2   (run 2)
CRAWL_LIVE=true npm run crawl:once -- --source=viva  --limit=2   (run 1)
CRAWL_LIVE=true npm run crawl:once -- --source=viva  --limit=2   (run 2)
```

## Per-source stdout summary (stored vs duplicate counts)

### detik

- **Run 1:** discovered 2 -> 2 `stored (new_article)`, 0 duplicate.
  - `https://news.detik.com/berita/d-8588052/khofifah-pimpin-misi-dagang-ke-hong-kong-transaksi-tembus-rp-12-038-t`
  - `https://news.detik.com/berita/d-8588049/bobby-nasution-jadi-gubernur-sumut-pertama-yang-berkantor-di-kepulauan-nias`
  - `[crawl-once] done. 2/2 article(s) stored/deduped for "detik".`
- **Run 2:** discovered 2 (same URLs) -> 0 stored, 2 `duplicate (duplicate_content)`.
  - `[crawl-once] done. 2/2 article(s) stored/deduped for "detik".`

### suara

- **Run 1:** discovered 2 -> 2 `stored (new_article)`, 0 duplicate.
  - `https://www.suara.com/bisnis/2026/07/24/101120/iwip-terapkan-prinsip-ekonomi-sirkular-kelola-sampah-domestik`
  - `https://www.suara.com/lifestyle/2026/07/24/101008/kenapa-login-sulingjar-2026-gagal-terus-ini-cara-mengatasinya`
  - `[crawl-once] done. 2/2 article(s) stored/deduped for "suara".`
- **Run 2:** discovered 2 (same URLs) -> 0 stored, 2 `duplicate (duplicate_content)`.
  - `[crawl-once] done. 2/2 article(s) stored/deduped for "suara".`

### viva

- **Run 1:** discovered 2 -> 2 `stored (new_article)`, 0 duplicate. Note: this is a change from
  prior Sprint 0 QA (`docs/SPRINT0_QA.md`), which observed 0 live candidates from VIVA's
  `/indeks` due to markup drift. S1-A's selector fix appears to have restored live discovery -
  confirmed here empirically (2 real candidates returned, not 0).
  - `https://www.viva.co.id/sport/1915974-bank-bjb-permudah-masyarakat-ikut-merbabu-trail-run-lewat-program-menabung`
  - `https://www.viva.co.id/berita/dunia/1915972-sugiono-dan-7-menlu-kutuk-keras-eskalasi-israel-di-masjid-al-aqsa-desak-dunia-ambil-sikap-tegas`
  - `[crawl-once] done. 2/2 article(s) stored/deduped for "viva".`
- **Run 2:** discovered 2 (same URLs) -> 0 stored, 2 `duplicate (duplicate_content)`.
  - `[crawl-once] done. 2/2 article(s) stored/deduped for "viva".`

## SQL evidence

Query run per source (`source_id` substituted):

```sql
SELECT source_id, canonical_url, left(title,80) AS title,
       summary IS NOT NULL AS has_summary,
       left(summary,100) AS summary_preview,
       thumbnail_url IS NOT NULL AS has_thumb,
       thumbnail_url,
       published_at,
       content_hash
FROM articles
WHERE source_id = '<id>'
ORDER BY article_id DESC
LIMIT 20;
```

(All 2 rows per source were within this session's live-crawl window; no `collected_at` time
filter was needed since each source's `articles` table only contains this session's 2 live rows.)

### detik (2 rows)

| canonical_url | has_summary | has_thumb | published_at |
|---|---|---|---|
| `.../berita/d-8588049/bobby-nasution-jadi-gubernur-sumut-pertama-yang-berkantor-di-kepulauan-nias` | t | t | 2026-07-24 03:11:02+00 |
| `.../berita/d-8588052/khofifah-pimpin-misi-dagang-ke-hong-kong-transaksi-tembus-rp-12-038-t` | t | t | 2026-07-24 03:13:49+00 |

Sample thumbnail_url: `https://akcdn.detik.net.id/community/media/visual/2026/07/24/bobby-nasution-jadi-gubernur-sumut-pertama-yang-berkantor-di-kepulauan-nias-1784862606346.jpeg?w=1200`

Sample summary_preview: "Gubernur Sumut, Bobby Nasution, menjadi yang pertama berkantor di Nias, mempercepat pembangunan dan ..."

### suara (2 rows)

| canonical_url | has_summary | has_thumb | published_at |
|---|---|---|---|
| `.../lifestyle/2026/07/24/101008/kenapa-login-sulingjar-2026-gagal-terus-ini-cara-mengatasinya` | t | t | 2026-07-24 03:10:08+00 |
| `.../bisnis/2026/07/24/101120/iwip-terapkan-prinsip-ekonomi-sirkular-kelola-sampah-domestik` | t | t | 2026-07-24 03:11:20+00 |

Sample thumbnail_url: `https://media.suara.com/pictures/1600x840/2025/09/18/82779-cara-mengatasi-download-kartu-sulingjar-gagal.jpg`

Sample summary_preview: "Kendala login Sulingjar 2026 sering terjadi akibat salah data, penggunaan HP, atau server padat. Ata..."

### viva (2 rows)

| canonical_url | has_summary | has_thumb | published_at |
|---|---|---|---|
| `.../berita/dunia/1915972-sugiono-dan-7-menlu-kutuk-keras-eskalasi-israel-di-masjid-al-aqsa-desak-dunia-ambil-sikap-tegas` | t | t | 2026-07-24 03:04:55+00 |
| `.../sport/1915974-bank-bjb-permudah-masyarakat-ikut-merbabu-trail-run-lewat-program-menabung` | t | t | 2026-07-24 03:16:48+00 |

Sample thumbnail_url: `https://thumb.viva.co.id/media/frontend/thumbs3/2024/03/06/65e82409ab485-masjid-al-aqsa-di-yerusalem-palestina_1265_711.jpg`

Sample summary_preview: "Menlu Sugiono bersama tujuh menteri luar negeri negara lain mengecam eskalasi Israel di Masjid Al-Aq..."

## Idempotency check (distinct canonical_url count after 2 runs, per source)

```sql
SELECT source_id, COUNT(*) AS rows, COUNT(DISTINCT canonical_url) AS distinct_urls,
       SUM((thumbnail_url IS NOT NULL)::int) AS thumb_filled,
       SUM((summary IS NOT NULL)::int) AS summary_filled,
       SUM((published_at IS NOT NULL)::int) AS published_filled
FROM articles
WHERE source_id IN ('detik','suara','viva')
GROUP BY source_id ORDER BY source_id;
```

| source_id | rows | distinct_urls | thumb_filled | summary_filled | published_filled |
|---|---|---|---|---|---|
| detik | 2 | 2 | 2 | 2 | 2 |
| suara | 2 | 2 | 2 | 2 | 2 |
| viva  | 2 | 2 | 2 | 2 | 2 |

Row count and distinct-URL count did **not** grow between run 1 and run 2 for any source (2 rows
after run 1, still 2 rows after run 2) - confirms content-hash/unique-constraint idempotency held
for live URLs, matching the fixture-path behavior documented in `docs/DB_VERIFY_REPORT.md`.

`discovered_urls` bookkeeping cross-check (also did not double on run 2):

| source_id | discovered_url_rows |
|---|---|
| detik | 2 |
| suara | 2 |
| viva  | 2 |

## Fill-rate summary (live-stored rows this session, N=2 per source, N=6 total)

| source | thumbnail_url filled | summary filled | published_at filled |
|---|---|---|---|
| detik | 2/2 (100%) | 2/2 (100%) | 2/2 (100%) |
| suara | 2/2 (100%) | 2/2 (100%) | 2/2 (100%) |
| viva  | 2/2 (100%) | 2/2 (100%) | 2/2 (100%) |
| **all sources** | **6/6 (100%)** | **6/6 (100%)** | **6/6 (100%)** |

## Cleanup

- Disposable container `egi_crawl_qa` was stopped and removed after this session:
  `docker rm -f egi_crawl_qa`.
- Editorial `egi-postgres` (port 5433) was never touched.
- No adapter, core, README, `.env.example`, or `target-sites.md`/playbook files were modified.

## Note on scope

No GO/NO-GO verdict is recorded in this document - that is S1-C's call. This document is raw
execution evidence only (commands run, stdout counts, SQL query results, fill rates).

**READY FOR S1-C.**
