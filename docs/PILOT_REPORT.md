# Pilot Report

**Agent:** Pilot Agent P4 (Integrator / QA)
**Scope:** `egi-media-crawl` — verifikasi wiring integrasi untuk adapter pilot `detik`, `suara`, `viva`.
**Lingkungan verifikasi:** Node.js v24.18.0, Windows, tanpa Postgres/Redis/Docker aktif (offline untuk DB; internet tersedia untuk uji live opsional).

## status_per_source

| source | adapter loads | fixture parse | discover | crawl:once | notes |
|---|---|---|---|---|---|
| detik | OK — `getAdapter('detik')` + `assertAdapterShape()` lolos | OK — title & `content_text` non-empty (416 char) dari `fixtures/detik/sample-article.html` | OK (fixture, 2 item, channel `fixture`); live sample sukses (8 item nyata dari `news.detik.com/indeks`) saat `CRAWL_LIVE=true` | Terverifikasi sampai batas lingkungan: fail-fast yang benar saat `DATABASE_URL` tidak diset; pipeline discover→fetch→parse penuh (tanpa store) sukses offline, `fetchResult.fromCache=true` (fixture, bukan live) | Bug integrasi ditemukan & diperbaiki: `discover()` mentah detik **mengabaikan** `CRAWL_LIVE` dan selalu live kecuali `ctx.fixtureOnly` diset — sebelum fix, `crawl-once`/worker discover diam-diam memukul `news.detik.com` walau `CRAWL_LIVE` tidak diset |
| suara | OK — `getAdapter('suara')` + `assertAdapterShape()` lolos | OK — title & `content_text` non-empty (561 char, multipage merge 2 halaman) dari `fixtures/suara/sample-article.html` | OK (fixture, 2 item, channel `fixture`); live sample **timeout 12s** (non-blocking, tidak wajib untuk go/no-go) | Terverifikasi sampai batas lingkungan: fail-fast benar tanpa `DATABASE_URL`; pipeline discover→fetch→parse penuh (tanpa store) sukses offline, `fromCache=true` setelah fix | Bug integrasi ditemukan & diperbaiki: `fetchHtml.js` `FIXTURE_PATHS` sebelumnya **hanya** berisi `detik` — tanpa fix, tahap fetch untuk `suara` akan mencoba `axios.get()` langsung ke URL fixture palsu (live hit tak terduga) meski `CRAWL_LIVE` tidak diset |
| viva | OK — `getAdapter('viva')` + `assertAdapterShape()` lolos | OK — title & `content_text` non-empty (942 char) dari `fixtures/viva/sample-article.html`; **`summary` selalu `undefined`** (adapter mentah tidak mengekstraknya — di luar scope integrasi, lihat catatan) | OK (fixture, 8 item, channel `fixture`); live sample **timeout 12s** (non-blocking) | Terverifikasi sampai batas lingkungan: fail-fast benar tanpa `DATABASE_URL`; pipeline discover→fetch→parse penuh (tanpa store) sukses offline, `fromCache=true` setelah fix | Sama seperti suara — mendapat manfaat dari fix `FIXTURE_PATHS` di atas |

Catatan umum: **crawl:once dengan store ke Postgres (`--source=detik`, migrasi 002, duplicate-check re-run) tidak bisa dijalankan** di lingkungan ini karena tidak ada instans Postgres/Docker yang berjalan (`docker ps` gagal connect, tidak ada `psql`/binary Postgres lokal). Semua langkah *sebelum* database (registry, adapter loading, discover, fetch/fixture gating, parse) sudah diverifikasi lolos secara offline dengan menjalankan `runPipeline` langsung (tanpa `storeFn`) memakai `fetchArticleHtml` yang sama dengan yang dipakai `scripts/crawl-once.js`.

## field_fill (fixture)

| source | title | content_text | published_at | author_name | summary | external_id |
|---|---|---|---|---|---|---|
| detik | ✅ "Contoh Judul Berita Detik" | ✅ (416 char) | ✅ 2026-07-23T07:35:00.000Z | ✅ "Tim detikcom" | ✅ | ✅ "d-1234567" |
| suara | ✅ "Contoh Judul Berita Suara Multipage" | ✅ (561 char, 2 halaman digabung) | ✅ 2026-07-24T00:08:59.000Z | ✅ "Contoh Penulis Satu, Contoh Penulis Dua" | ✅ | ✅ "9990001" |
| viva | ✅ "Menteri Luncurkan Program Ketahanan Pangan Nasional" | ✅ (942 char) | ✅ 2026-07-23T23:10:00.000Z | ✅ "Andi Saputra" | ❌ `undefined` (field tidak diekstrak oleh adapter mentah `viva/index.js`; `coreAdapter.js` juga tidak memetakan `summary`) | ✅ "1234561" |

## integration_fixes

Semua perbaikan bersifat integrasi (tidak mengubah logika `parse()`/`discover()` inti adapter), sesuai batasan tugas:

1. **`src/workers/lib/fetchHtml.js`** — `FIXTURE_PATHS` sebelumnya hanya memetakan `detik`. Ditambahkan entri untuk `suara` (`fixtures/suara/sample-article.html`) dan `viva` (`fixtures/viva/sample-article.html`). Tanpa ini, langkah fetch untuk kedua source tersebut selalu mencoba `axios.get()` sungguhan ke URL fixture (fiktif) walau `CRAWL_LIVE` tidak diset — persis skenario "surprise live hit" yang harus dicegah.
2. **`scripts/crawl-once.js`** — `adapter.discover()` sekarang dipanggil dengan `ctx.fixtureOnly = !CRAWL_LIVE` dan `ctx.liveDiscover = CRAWL_LIVE`, memakai `isLiveCrawlEnabled()` yang sama dari `fetchHtml.js`. Ini memperbaiki bug nyata: `discover()` mentah `detik` **tidak** membaca `CRAWL_LIVE` sama sekali — ia hanya menghindari fetch live jika caller mengirim `ctx.fixtureOnly`, yang sebelumnya tidak pernah dikirim oleh `crawl-once.js`. Sebelum fix, menjalankan `crawl:once -- --source=detik` tanpa `CRAWL_LIVE` **tetap memukul** `news.detik.com/indeks` secara live (dikonfirmasi lewat pengujian langsung — replikasi bug menghasilkan 8 URL sungguhan dari indeks live).
3. **`src/workers/handlers/discover.js`** — perbaikan yang sama (gating `fixtureOnly`/`liveDiscover` berbasis `CRAWL_LIVE`) diterapkan juga di sini agar jalur worker BullMQ (`crawl-discover`) konsisten dengan `crawl-once` dan tidak punya kebocoran live-hit yang sama.
4. **`README.md`** — didokumentasikan ulang: cara migrasi (`npm run migrate`, urutan 001→002, kapan wajib re-run), `crawl:once` per source (`--source=detik|suara|viva`), env yang dibutuhkan (`DATABASE_URL` untuk store), dan bagian baru "`CRAWL_LIVE` (fixture vs. live crawling)" berisi peringatan eksplisit sebelum mengaktifkan live crawling.
5. **`.env.example`** — ditambahkan `CRAWL_LIVE=false` (default aman) dengan komentar pengarah ke README.

Tidak ada perubahan pada `src/adapters/index.js` maupun `src/sources/registry.js` — keduanya sudah benar untuk ketiga source (dikonfirmasi lewat pengujian, lihat tabel status di atas), sehingga tidak ada bug registry yang menghalangi loading.

## go_no_go

**GO (dengan catatan)** untuk melanjutkan pilot `detik`, `suara`, `viva` ke tahap berikutnya (shadow mode / uji dengan Postgres sungguhan), dengan alasan:

- Wiring integrasi inti (adapter loading, registry, contract shape, fixture parse, fixture discover, fixture fetch) terverifikasi bekerja untuk **ketiga** source setelah fix.
- Dua bug integrasi nyata (surprise live-hit di fetch untuk `suara`/`viva`, dan discover `detik` yang mengabaikan `CRAWL_LIVE`) sudah ditemukan dan diperbaiki dengan diff minimal, tanpa menyentuh logika parse/discover per-adapter.
- Live discover untuk `detik` terbukti bekerja saat `CRAWL_LIVE=true` (bukan syarat go, tapi sinyal positif tambahan).

Catatan yang membatasi kepercayaan (bukan blocker, tapi harus ditindaklanjuti sebelum go-live produksi):

- **Belum ada verifikasi end-to-end dengan Postgres sungguhan** (store, idempotency re-run, migrasi 002) karena tidak ada instans database di lingkungan ini — perlu dijalankan ulang di environment dengan Postgres sebelum sign-off penuh.
- Live discover `suara`/`viva` timeout 12 detik di lingkungan ini (kemungkinan sandbox/network, bukan indikasi pasti soal keandalan situs) — perlu dicoba ulang dari environment dengan akses jaringan yang lebih representatif sebelum mengaktifkan `CRAWL_LIVE=true` di produksi.
- `viva` tidak mengisi field `summary` — bukan bug integrasi (di luar scope perbaikan P4), tapi perlu dicatat sebagai gap kualitas data untuk adapter owner (F5/P3).

## next_recommended_media

- Jalankan `npm run migrate` + `crawl:once` penuh (termasuk 2x run untuk cek idempotency `duplicate`) di environment dengan Postgres aktif untuk ketiga source, sebelum mengaktifkan scheduler/worker produksi.
- Tambahkan media pilot berikutnya sesuai `target-sites.md` (tidak diubah dalam tugas ini) begitu tiga source ini lolos shadow mode dengan database sungguhan.
- Isi gap `summary` pada adapter `viva` (tugas F5/P3, bukan bagian dari perbaikan integrasi P4 ini).
