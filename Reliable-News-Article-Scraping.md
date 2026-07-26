# Reliable News Article Scraping

## Panduan End-to-End Membangun Crawler Artikel Berita yang Terukur, Tahan Perubahan, dan Tidak Bergantung pada RSS atau News Sitemap

**Versi:** 1.0  
**Tanggal:** 21 Juli 2026  
**Format:** Engineering Playbook  
**Target pembaca:** Backend Engineer, Data Engineer, Web Scraping Engineer, dan Technical Lead

---

## Daftar Isi

1. [Tentang Buku Ini](#1-tentang-buku-ini)
2. [Masalah yang Ingin Diselesaikan](#2-masalah-yang-ingin-diselesaikan)
3. [Apa Arti Reliable dalam Scraping Berita](#3-apa-arti-reliable-dalam-scraping-berita)
4. [Prinsip Utama Sistem](#4-prinsip-utama-sistem)
5. [Arsitektur End-to-End](#5-arsitektur-end-to-end)
6. [Core Crawler dan Adapter Per Media](#6-core-crawler-dan-adapter-per-media)
7. [Source Registry dan Source Profile](#7-source-registry-dan-source-profile)
8. [Proses Onboarding Media Baru](#8-proses-onboarding-media-baru)
9. [Strategi Discovery URL Artikel](#9-strategi-discovery-url-artikel)
10. [Pagination, Load More, dan Infinite Scroll](#10-pagination-load-more-dan-infinite-scroll)
11. [Menggunakan API yang Dipakai Frontend](#11-menggunakan-api-yang-dipakai-frontend)
12. [RSS dan Sitemap sebagai Sumber Pelengkap](#12-rss-dan-sitemap-sebagai-sumber-pelengkap)
13. [Request, Rate Limit, Retry, dan Circuit Breaker](#13-request-rate-limit-retry-dan-circuit-breaker)
14. [Parsing Halaman Artikel](#14-parsing-halaman-artikel)
15. [Prioritas Sumber Metadata](#15-prioritas-sumber-metadata)
16. [Normalisasi URL dan Canonical URL](#16-normalisasi-url-dan-canonical-url)
17. [Validasi Artikel](#17-validasi-artikel)
18. [Deduplikasi](#18-deduplikasi)
19. [Penyimpanan Data](#19-penyimpanan-data)
20. [Scheduling dan Overlapping Crawl Window](#20-scheduling-dan-overlapping-crawl-window)
21. [Rekonsiliasi dan Coverage Audit](#21-rekonsiliasi-dan-coverage-audit)
22. [Monitoring, Alert, dan Observability](#22-monitoring-alert-dan-observability)
23. [Testing Strategy](#23-testing-strategy)
24. [Penanganan Perubahan Website](#24-penanganan-perubahan-website)
25. [Error Handling dan Recovery](#25-error-handling-dan-recovery)
26. [Backfill Artikel Lama](#26-backfill-artikel-lama)
27. [Keamanan, Etika, dan Kepatuhan](#27-keamanan-etika-dan-kepatuhan)
28. [Contoh End-to-End: Media HTML](#28-contoh-end-to-end-media-html)
29. [Contoh End-to-End: Media JavaScript](#29-contoh-end-to-end-media-javascript)
30. [Struktur Project Referensi](#30-struktur-project-referensi)
31. [Kontrak Adapter Referensi](#31-kontrak-adapter-referensi)
32. [Checklist Production Readiness](#32-checklist-production-readiness)
33. [Runbook Operasional](#33-runbook-operasional)
34. [Glosarium](#34-glosarium)
35. [Referensi Resmi](#35-referensi-resmi)

---

# 1. Tentang Buku Ini

Buku ini menjelaskan cara membangun sistem pengambilan artikel dari website berita secara end-to-end.

Fokus utama buku ini bukan sekadar cara mengambil HTML, tetapi bagaimana membuat sistem yang:

- memiliki coverage tinggi;
- tidak hanya bergantung pada RSS atau News Sitemap;
- dapat menangani struktur website yang berbeda-beda;
- dapat mengetahui ketika ada artikel yang terlewat;
- dapat mengetahui ketika adapter sebuah media rusak;
- dapat menambah media baru tanpa mengubah seluruh sistem;
- dapat dijalankan terus-menerus di production;
- memiliki logging, monitoring, retry, audit, dan recovery yang jelas.

Buku ini menggunakan pendekatan:

> **Satu core crawler umum, ditambah adapter khusus untuk setiap media.**

Halaman **Latest/All News**, halaman kategori, pagination, dan API yang digunakan frontend dijadikan jalur discovery utama. RSS, News Sitemap, dan sitemap umum dipakai sebagai sumber tambahan dan pembanding.

## 1.1 Hasil akhir yang diharapkan

Setelah mengikuti buku ini, engineer seharusnya dapat:

1. menganalisis struktur sebuah website berita;
2. menentukan strategi discovery yang tepat;
3. membuat source profile;
4. membuat adapter media;
5. menghubungkan adapter ke core crawler;
6. mengambil URL artikel dari beberapa jalur;
7. mengambil metadata dan isi artikel;
8. melakukan normalisasi dan deduplikasi;
9. menyimpan data dengan status yang jelas;
10. mengukur coverage;
11. mendeteksi artikel yang terlewat;
12. mendeteksi perubahan struktur website;
13. memperbaiki satu media tanpa mengganggu media lain.

## 1.2 Batasan buku

Buku ini tidak menjanjikan bahwa scraping eksternal dapat menjamin 100% artikel.

Tanpa akses resmi ke CMS, database, webhook, atau API internal publisher, tidak ada cara eksternal yang dapat membuktikan bahwa seluruh artikel internal publisher telah ditemukan.

Yang dapat dibuat adalah sistem dengan:

- coverage tinggi;
- risiko kehilangan yang rendah;
- mekanisme pengukuran;
- mekanisme deteksi anomali;
- mekanisme rekonsiliasi;
- bukti operasional yang dapat diaudit.

---

# 2. Masalah yang Ingin Diselesaikan

Pendekatan paling sederhana biasanya hanya membaca:

- RSS;
- News Sitemap;
- sitemap umum.

Pendekatan tersebut mudah, tetapi memiliki beberapa risiko:

- feed hanya memuat sejumlah artikel terbaru;
- feed hanya memuat kategori tertentu;
- artikel tertentu dapat dikecualikan;
- sitemap dapat terlambat diperbarui;
- artikel dapat tidak masuk sitemap sama sekali;
- konfigurasi CMS dapat salah;
- satu media dapat memiliki banyak sitemap;
- artikel dapat terbit di halaman kategori tetapi tidak muncul di feed;
- artikel dapat ditemukan melalui API frontend, tetapi tidak terlihat di sitemap;
- artikel dapat diperbarui tanpa URL baru.

Google sendiri menjelaskan bahwa sitemap merupakan petunjuk untuk membantu discovery, bukan jaminan bahwa seluruh URL akan diambil atau digunakan. [R1][R2]

Karena itu, sistem tidak boleh memiliki asumsi:

> “Jika artikel diterbitkan, artikel pasti ada di RSS atau sitemap.”

Asumsi yang lebih aman:

> “Artikel dapat muncul melalui satu atau beberapa jalur discovery. Sistem harus menggabungkan jalur-jalur tersebut dan mengaudit perbedaannya.”

---

# 3. Apa Arti Reliable dalam Scraping Berita

Reliable bukan hanya berarti request berhasil mendapatkan HTTP 200.

Sistem disebut reliable jika memenuhi beberapa dimensi berikut.

## 3.1 Discovery reliability

Kemampuan menemukan URL artikel yang benar-benar diterbitkan.

Contoh indikator:

- URL ditemukan dari Latest page;
- URL ditemukan dari halaman kategori;
- URL ditemukan dari pagination;
- URL ditemukan dari API frontend;
- URL ditemukan dari sitemap;
- URL ditemukan dari RSS;
- URL yang hanya muncul pada satu jalur tetap dapat diproses.

## 3.2 Extraction reliability

Kemampuan mengambil field artikel secara benar.

Field minimum:

- source;
- article URL;
- canonical URL;
- title;
- published time;
- content;
- collected time.

Field tambahan:

- author;
- category;
- summary;
- image;
- updated time;
- language;
- tags.

## 3.3 Delivery reliability

Kemampuan memastikan artikel yang ditemukan akhirnya tersimpan atau memiliki status kegagalan yang dapat ditindaklanjuti.

Setiap URL harus berakhir pada salah satu status:

- `stored`;
- `duplicate`;
- `invalid`;
- `blocked`;
- `retry_scheduled`;
- `dead_letter`;
- `ignored_by_policy`.

Jangan membiarkan URL hilang tanpa status.

## 3.4 Operational reliability

Kemampuan sistem untuk:

- tetap berjalan ketika satu media gagal;
- membatasi request agar tidak membebani website;
- mengulang kegagalan sementara;
- menghentikan request ketika media bermasalah;
- memberi alert ketika output tidak normal;
- menyediakan log untuk investigasi.

## 3.5 Measurable reliability

Reliability harus diukur, bukan hanya diasumsikan.

Contoh metrik:

```text
discovered_urls
fetched_urls
parsed_articles
valid_articles
stored_articles
duplicate_articles
failed_urls
missing_from_primary_discovery
coverage_proxy
parse_success_rate
```

## 3.6 Definisi keberhasilan yang disarankan

Untuk setiap media, tetapkan target seperti:

- parse success rate minimal 98%;
- URL tanpa status akhir kurang dari 0,1%;
- tidak ada run yang menghasilkan nol artikel tanpa alert;
- selisih discovery antarjalur diperiksa;
- seluruh kegagalan permanen masuk dead-letter queue;
- adapter memiliki fixture test;
- perubahan volume artikel terdeteksi secara otomatis.

Target harus disesuaikan dengan karakter media.

---

# 4. Prinsip Utama Sistem

## 4.1 Listing page sebagai jalur utama

Gunakan halaman berikut sebagai jalur utama jika tersedia:

1. Latest;
2. All News;
3. seluruh halaman kategori;
4. seluruh subkategori penting;
5. pagination atau load more;
6. endpoint JSON yang digunakan halaman listing.

Alasannya: halaman tersebut biasanya menjadi representasi artikel yang ditampilkan kepada pembaca.

## 4.2 Multi-source discovery

Jangan memilih hanya satu jalur.

Gunakan gabungan:

```text
Latest page
+ Category pages
+ Pagination
+ Frontend API
+ RSS
+ News Sitemap
+ General Sitemap
```

Setiap jalur menghasilkan kumpulan URL. Seluruh URL kemudian digabungkan dan dinormalisasi.

## 4.3 Re-crawl dengan overlap

Jangan hanya mengambil halaman terbaru sekali.

Periksa ulang jendela waktu sebelumnya, misalnya 72 jam terakhir. Tujuannya:

- menangkap artikel yang terlambat muncul;
- menangkap artikel yang berpindah kategori;
- menangkap artikel yang baru masuk sitemap;
- menangkap update metadata;
- memulihkan kegagalan sementara.

## 4.4 At-least-once discovery

Lebih aman menemukan URL yang sama beberapa kali daripada hanya sekali lalu kehilangan artikel.

Konsekuensinya, deduplikasi harus kuat.

## 4.5 Idempotent processing

Memproses URL yang sama berulang kali tidak boleh membuat duplikat data.

Contoh:

```text
URL ditemukan dari Latest
URL yang sama ditemukan dari kategori
URL yang sama ditemukan dari RSS
URL yang sama ditemukan lagi dua jam kemudian
```

Hasil akhirnya tetap satu artikel.

## 4.6 Per-media isolation

Kegagalan Media A tidak boleh menghentikan Media B.

Setiap media memiliki:

- adapter;
- queue partition atau source key;
- rate limit;
- circuit breaker;
- metrik;
- alert;
- konfigurasi;
- status aktivasi.

## 4.7 Configuration before customization

Gunakan konfigurasi untuk perbedaan sederhana seperti selector dan URL.

Gunakan kode adapter khusus hanya jika website memerlukan logika yang tidak dapat direpresentasikan dengan konfigurasi.

## 4.8 Evidence-based completeness

Jangan menyatakan coverage tinggi hanya karena crawler tidak error.

Coverage harus dinilai menggunakan:

- perbandingan antarjalur;
- audit manual;
- histori volume;
- sampling;
- rekonsiliasi;
- daftar URL listing;
- daftar URL yang berhasil diproses.

---

# 5. Arsitektur End-to-End

Arsitektur logis:

```text
Scheduler
    ↓
Source Registry
    ↓
Discovery Orchestrator
    ↓
Source Adapter
    ├── Latest
    ├── Categories
    ├── Pagination
    ├── Frontend API
    ├── RSS
    └── Sitemaps
    ↓
URL Normalizer
    ↓
Discovery Store
    ↓
Article Queue
    ↓
Fetcher
    ↓
Article Parser
    ↓
Validator
    ↓
Canonicalizer
    ↓
Deduplicator
    ↓
Article Storage
    ↓
Reconciliation
    ↓
Coverage Audit
    ↓
Monitoring dan Alert
```

## 5.1 Komponen utama

### Scheduler

Menentukan kapan sebuah media diperiksa.

### Source Registry

Menyimpan daftar media, status, konfigurasi, dan adapter yang digunakan.

### Discovery Orchestrator

Menjalankan seluruh jalur discovery sesuai source profile.

### Source Adapter

Memahami bentuk khusus website sebuah media.

### URL Normalizer

Membersihkan dan menyeragamkan URL.

### Discovery Store

Menyimpan bukti bahwa sebuah URL pernah ditemukan.

### Article Queue

Memisahkan discovery dari proses fetch artikel.

### Fetcher

Mengambil halaman atau respons API dengan kebijakan request yang aman.

### Article Parser

Mengubah HTML atau JSON menjadi data artikel terstruktur.

### Validator

Memastikan data memenuhi syarat minimum.

### Deduplicator

Mencegah artikel yang sama tersimpan lebih dari sekali.

### Article Storage

Menyimpan artikel dan riwayat perubahan.

### Reconciliation Engine

Membandingkan hasil antarjalur dan mendeteksi URL yang belum diproses.

### Monitoring

Mengukur kondisi sistem dan mengirim alert.

---

# 6. Core Crawler dan Adapter Per Media

## 6.1 Core crawler

Core crawler berisi kemampuan umum yang digunakan seluruh media.

Tanggung jawabnya:

- scheduling;
- queue;
- HTTP request;
- timeout;
- retry;
- rate limit;
- robots policy;
- redirect handling;
- logging;
- metrics;
- tracing;
- normalisasi URL;
- deduplikasi;
- validasi umum;
- penyimpanan;
- reconciliation;
- alert.

Core crawler tidak mengetahui selector spesifik suatu media.

Contoh hal yang tidak boleh di-hardcode di core:

```text
.article-card a
#article-body
.published-at
/load-more?page=2
```

Semua aturan tersebut milik adapter atau source profile.

## 6.2 Adapter per media

Adapter menjelaskan cara berinteraksi dengan satu website.

Tanggung jawabnya:

- mengembalikan URL seed;
- menemukan URL artikel;
- menentukan pola pagination;
- memanggil endpoint listing;
- membedakan URL artikel dan non-artikel;
- membaca artikel;
- menginterpretasikan tanggal;
- membersihkan elemen nonkonten;
- memberi petunjuk canonical;
- menangani variasi khusus media.

## 6.3 Analogi tanggung jawab

```text
Core crawler:
Mengatur bagaimana pekerjaan dijalankan.

Adapter:
Menjelaskan apa yang harus diambil dari satu media.
```

## 6.4 Mengapa harus dipisahkan

Tanpa pemisahan:

- perubahan satu selector dapat merusak sistem besar;
- kode dipenuhi kondisi `if source == ...`;
- testing sulit;
- rollout media baru berisiko;
- engineer sulit mengetahui pemilik logika;
- kegagalan satu media dapat menyebar.

Dengan adapter:

- Media A dan Media B terisolasi;
- adapter dapat dinonaktifkan;
- test fixture dapat dibuat per media;
- perubahan website hanya memerlukan perubahan lokal;
- konfigurasi deployment lebih aman.

---

# 7. Source Registry dan Source Profile

Source registry adalah daftar seluruh media yang dikelola sistem.

## 7.1 Contoh source registry

```yaml
sources:
  - source_id: media_a
    display_name: Media A
    base_url: https://news-a.example
    adapter: media_a_v1
    enabled: true
    timezone: Asia/Jakarta
    crawl_interval_minutes: 10
    overlap_hours: 72
    max_requests_per_minute: 20
    priority: high

  - source_id: media_b
    display_name: Media B
    base_url: https://news-b.example
    adapter: media_b_v2
    enabled: true
    timezone: UTC
    crawl_interval_minutes: 15
    overlap_hours: 96
    max_requests_per_minute: 10
    priority: normal
```

## 7.2 Source profile

Source profile adalah dokumen teknis satu media.

Field yang disarankan:

```yaml
source_id: media_a
base_url: https://news-a.example
allowed_domains:
  - news-a.example
  - www.news-a.example

discovery:
  latest:
    enabled: true
    url: https://news-a.example/latest
    parser: html
    article_link_selector: ".article-card a"
    max_pages_per_run: 10

  categories:
    enabled: true
    urls:
      - https://news-a.example/business
      - https://news-a.example/technology
      - https://news-a.example/national

  pagination:
    type: query_parameter
    parameter: page
    start: 1

  rss:
    enabled: true
    urls:
      - https://news-a.example/rss

  sitemaps:
    enabled: true
    urls:
      - https://news-a.example/news-sitemap.xml
      - https://news-a.example/sitemap.xml

article:
  url_patterns:
    include:
      - "^https://news-a\.example/[a-z-]+/\d{4}/\d{2}/\d{2}/"
    exclude:
      - "/video/"
      - "/gallery/"
      - "/tag/"

  parser:
    json_ld_types:
      - NewsArticle
      - Article
    title_selector: "h1.article-title"
    content_selector: "div.article-body"
    published_selector: "time.published"
    author_selector: ".author-name"
    category_selector: ".breadcrumb a:last-child"
    remove_selectors:
      - ".advertisement"
      - ".related-articles"
      - ".social-share"
      - "script"
      - "style"

policy:
  respect_robots: true
  allow_browser_rendering: false
  store_full_content: true
```

## 7.3 Versioning

Adapter dan source profile harus memiliki versi.

Contoh:

```text
media_a_v1
media_a_v2
```

Simpan informasi berikut pada setiap hasil:

```text
adapter_version
parser_version
source_profile_version
```

Hal ini penting untuk menjawab:

- artikel diproses menggunakan aturan yang mana;
- kapan hasil berubah;
- adapter mana yang menghasilkan error;
- apakah artikel perlu diproses ulang.

---

# 8. Proses Onboarding Media Baru

Jangan langsung membuat selector tanpa analisis.

Gunakan tahapan berikut.

## 8.1 Tahap 1 — Pemeriksaan izin dan batasan

Periksa:

- Terms of Service;
- robots.txt;
- kebutuhan lisensi;
- batas penggunaan konten;
- apakah ada API resmi;
- apakah media mengharuskan autentikasi;
- apakah konten berada di balik paywall;
- apakah penyimpanan isi penuh diperbolehkan.

Robots Exclusion Protocol telah distandardisasi pada RFC 9309. Sistem perlu memiliki kebijakan eksplisit untuk mematuhi aturan yang berlaku. [R5]

## 8.2 Tahap 2 — Pemetaan website

Cari:

- homepage;
- Latest atau All News;
- daftar kategori;
- subkategori;
- halaman tag;
- halaman penulis;
- pagination;
- load more;
- infinite scroll;
- sitemap index;
- News Sitemap;
- RSS;
- endpoint JSON;
- pola URL artikel;
- halaman video dan galeri.

## 8.3 Tahap 3 — Identifikasi sumber kebenaran discovery

Tentukan jalur utama.

Contoh keputusan:

```text
Primary:
- Latest API
- Category API

Secondary:
- HTML listing
- RSS
- News Sitemap
```

Atau:

```text
Primary:
- Latest HTML
- seluruh category HTML

Secondary:
- sitemap
```

## 8.4 Tahap 4 — Sampling manual

Ambil sampel artikel selama beberapa hari.

Untuk setiap artikel yang terlihat di website, catat:

| Field | Nilai |
|---|---|
| URL artikel | URL |
| Muncul di Latest | Ya/Tidak |
| Muncul di kategori | Ya/Tidak |
| Muncul di RSS | Ya/Tidak |
| Muncul di News Sitemap | Ya/Tidak |
| Muncul di sitemap umum | Ya/Tidak |
| Dapat diparse | Ya/Tidak |
| Catatan | Kondisi khusus |

Tujuan sampling adalah mengetahui coverage tiap jalur.

## 8.5 Tahap 5 — Buat source profile

Dokumentasikan seluruh hasil analisis.

## 8.6 Tahap 6 — Buat fixture

Simpan contoh HTML atau JSON untuk:

- listing normal;
- artikel normal;
- artikel dengan video;
- artikel tanpa author;
- artikel diperbarui;
- halaman error;
- halaman kosong.

## 8.7 Tahap 7 — Shadow mode

Jalankan adapter tanpa memasukkan data ke production.

Shadow mode digunakan untuk:

- membandingkan volume;
- menguji rate limit;
- memeriksa false positive;
- memeriksa artikel terlewat;
- mengukur parse success.

## 8.8 Tahap 8 — Production activation

Aktifkan secara bertahap.

Contoh:

1. discovery saja;
2. parsing;
3. penyimpanan staging;
4. audit manual;
5. penyimpanan production;
6. alert aktif.

---

# 9. Strategi Discovery URL Artikel

Discovery adalah proses menemukan URL kandidat artikel.

Discovery tidak mengambil isi artikel secara penuh. Discovery hanya mengumpulkan URL dan metadata ringan.

## 9.1 Latest atau All News

Ini biasanya jalur paling penting.

Ambil:

- URL artikel;
- judul listing;
- waktu listing jika tersedia;
- kategori;
- page number;
- discovery time.

Simpan bukti discovery:

```json
{
  "source_id": "media_a",
  "url": "https://news-a.example/article-123",
  "channel": "latest_html",
  "discovered_at": "2026-07-21T09:00:00Z",
  "listing_page": 1,
  "listing_title": "Contoh Judul"
}
```

## 9.2 Seluruh kategori

Jangan menganggap Latest memuat semua jenis konten.

Beberapa media memiliki:

- artikel premium;
- opini;
- regional;
- ekonomi;
- teknologi;
- internasional;
- data;
- investigasi;
- foto;
- video.

Tentukan jenis yang masuk scope.

## 9.3 Subkategori

Kategori utama kadang hanya menampilkan subset.

Contoh:

```text
Business
├── Economy
├── Market
├── Banking
└── Energy
```

Jika halaman Business tidak menggabungkan seluruh subkategori, crawler harus memeriksa subkategori.

## 9.4 Homepage

Homepage dapat dipakai sebagai sumber pelengkap.

Homepage tidak cocok sebagai satu-satunya sumber karena:

- hanya menampilkan artikel pilihan;
- artikel cepat tergeser;
- tidak semua kategori tampil;
- posisi tergantung editorial curation.

## 9.5 Halaman tag dan penulis

Biasanya bukan sumber utama.

Gunakan hanya jika audit menunjukkan ada tipe artikel yang tidak muncul pada Latest atau kategori.

## 9.6 Pola URL

Filter URL berdasarkan aturan.

Contoh include:

```regex
^https://news-a\.example/news/\d{4}/\d{2}/\d{2}/
```

Contoh exclude:

```regex
/tag/
/author/
/search/
/login/
/subscription/
/video/
/gallery/
```

Jangan hanya mengandalkan regex. Tetap validasi halaman hasil fetch.

## 9.7 Multi-channel union

Hasil akhir discovery:

```text
candidate_urls =
    latest_urls
    ∪ category_urls
    ∪ api_urls
    ∪ rss_urls
    ∪ news_sitemap_urls
    ∪ general_sitemap_urls
```

Setelah union:

1. resolve relative URL;
2. normalisasi;
3. filter domain;
4. filter pola;
5. simpan discovery evidence;
6. enqueue URL yang perlu diproses.

## 9.8 Stop condition

Crawler listing harus tahu kapan berhenti.

Contoh stop condition:

- halaman kosong;
- tidak ada URL baru;
- seluruh artikel lebih lama dari overlap window;
- page number mencapai batas;
- API mengembalikan `has_next=false`;
- cursor pagination kosong;
- fingerprint halaman sama dengan halaman sebelumnya.

Jangan hanya berhenti ketika HTTP 404 karena beberapa website mengulang halaman terakhir.

---

# 10. Pagination, Load More, dan Infinite Scroll

## 10.1 Query parameter

Contoh:

```text
/latest?page=1
/latest?page=2
```

Validasi bahwa page 2 benar-benar berbeda dari page 1.

## 10.2 Path pagination

Contoh:

```text
/latest/page/1
/latest/page/2
```

## 10.3 Offset dan limit

Contoh:

```text
/api/articles?offset=0&limit=20
/api/articles?offset=20&limit=20
```

## 10.4 Cursor pagination

Contoh:

```json
{
  "items": [],
  "next_cursor": "eyJpZCI6MTIzfQ=="
}
```

Simpan cursor hanya sebagai state teknis. Jangan mengandalkan cursor lama untuk recovery permanen karena cursor dapat kedaluwarsa.

## 10.5 Load more

Tombol load more biasanya memanggil:

- endpoint JSON;
- endpoint HTML fragment;
- GraphQL;
- server action;
- endpoint internal framework.

Periksa Network tab browser untuk memahami request.

## 10.6 Infinite scroll

Jangan langsung menggunakan browser automation.

Urutan keputusan:

1. cari request API;
2. cari data di HTML awal;
3. cari JSON embedded;
4. cari endpoint pagination;
5. baru gunakan browser rendering jika tidak ada alternatif.

Browser automation lebih mahal, lebih lambat, dan lebih mudah rusak.

## 10.7 Dedup antarhalaman

Artikel dapat muncul pada beberapa page karena urutan berubah saat artikel baru diterbitkan.

Karena itu:

- gunakan set URL pada satu run;
- simpan discovery evidence;
- jangan menganggap setiap page berisi artikel unik;
- gunakan overlap page.

Contoh:

```text
Run 10:00 mengambil page 1–5
Run 10:10 mengambil page 1–5 lagi
```

Ini aman jika pemrosesan idempotent.

---

# 11. Menggunakan API yang Dipakai Frontend

Banyak website modern mengambil listing melalui API.

API tersebut dapat lebih stabil daripada selector HTML karena datanya sudah terstruktur.

## 11.1 Cara menemukan

Gunakan browser developer tools:

1. buka Network;
2. pilih Fetch/XHR;
3. reload halaman;
4. klik load more;
5. periksa request;
6. periksa query parameter;
7. periksa response;
8. periksa header yang diperlukan.

## 11.2 Data yang dicari

Contoh respons:

```json
{
  "items": [
    {
      "id": "123",
      "slug": "contoh-artikel",
      "url": "/news/contoh-artikel",
      "title": "Contoh Artikel",
      "published_at": "2026-07-21T10:00:00+07:00"
    }
  ],
  "next_page": 2
}
```

## 11.3 Syarat penggunaan

Sebelum menggunakan endpoint:

- pastikan tidak melewati autentikasi;
- jangan mengambil token pengguna;
- jangan menghindari paywall;
- jangan mengeksploitasi endpoint;
- patuhi batas penggunaan;
- periksa apakah endpoint memang dipanggil oleh halaman publik;
- jangan menganggap endpoint internal akan stabil selamanya.

## 11.4 API adapter

Adapter harus mengisolasi detail API.

```python
class MediaAAdapter:
    def discover_latest(self, context):
        page = 1

        while True:
            response = context.http.get(
                "https://news-a.example/api/articles",
                params={"page": page, "limit": 50}
            )

            payload = response.json()

            for item in payload["items"]:
                yield DiscoveryItem(
                    url=absolute_url(item["url"]),
                    published_hint=item.get("published_at"),
                    external_id=item.get("id"),
                    channel="latest_api"
                )

            if not payload.get("next_page"):
                break

            page = payload["next_page"]
```

## 11.5 Risiko API frontend

- endpoint berubah;
- parameter berubah;
- format JSON berubah;
- token publik berubah;
- hasil dipersonalisasi;
- cache berbeda;
- data hanya memuat teaser;
- endpoint memiliki rate limit.

Karena itu API tetap perlu:

- contract test;
- schema validation;
- fallback;
- monitoring volume;
- adapter versioning.

---

# 12. RSS dan Sitemap sebagai Sumber Pelengkap

## 12.1 Peran yang benar

Gunakan RSS dan sitemap untuk:

- mempercepat discovery;
- menemukan artikel yang tidak muncul di listing utama;
- rekonsiliasi;
- backfill;
- mengambil metadata tambahan;
- membandingkan coverage.

Jangan menjadikannya satu-satunya sumber.

## 12.2 News Sitemap

Google menjelaskan bahwa News Sitemap digunakan publisher untuk memberi informasi mengenai artikel berita. Artikel yang lebih tua dari dua hari tidak lagi perlu membawa metadata News Sitemap. [R2]

Implikasinya:

- News Sitemap berfokus pada artikel baru;
- tidak cocok untuk backfill jangka panjang;
- tidak membuktikan seluruh artikel publisher;
- tetap berguna sebagai jalur tambahan.

## 12.3 Sitemap umum

Sitemap umum dapat berisi:

- artikel;
- kategori;
- tag;
- author;
- halaman statis;
- video;
- gambar.

Crawler harus memfilter URL.

Sitemap index dapat menunjuk ke banyak file sitemap.

## 12.4 RSS

RSS dapat:

- dibatasi jumlah item;
- dibagi per kategori;
- tidak memuat seluruh artikel;
- hanya memuat ringkasan;
- tidak memiliki canonical URL yang konsisten.

## 12.5 Rekonsiliasi antarjalur

Contoh hasil:

```text
Latest:       120 URL
Categories:   126 URL
RSS:           80 URL
News Sitemap: 115 URL
Union:        130 URL
```

Pertanyaan audit:

- 4 URL apa yang hanya ada di kategori?
- 5 URL apa yang hanya ada di sitemap?
- apakah URL tersebut artikel valid?
- mengapa Latest tidak menampilkannya?
- apakah adapter Latest kehilangan elemen?

---

# 13. Request, Rate Limit, Retry, dan Circuit Breaker

## 13.1 Identitas crawler

Gunakan User-Agent yang jelas.

Contoh:

```text
ReliableNewsCrawler/1.0 (+https://example.com/crawler-info; contact=ops@example.com)
```

Jangan menyamar sebagai browser jika tidak diperlukan.

## 13.2 Timeout

Gunakan timeout terpisah:

- connection timeout;
- read timeout;
- total timeout.

Contoh awal:

```yaml
connect_timeout_seconds: 5
read_timeout_seconds: 20
total_timeout_seconds: 30
```

Sesuaikan berdasarkan media.

## 13.3 Rate limit

Tentukan per media.

Contoh:

```yaml
max_requests_per_minute: 20
max_concurrent_requests: 2
delay_between_requests_ms: 1000
```

Jangan menggunakan satu rate limit global untuk seluruh media.

## 13.4 Retry

Retry hanya untuk kegagalan yang mungkin sementara.

Umumnya retry:

- timeout;
- connection reset;
- HTTP 408;
- HTTP 429;
- HTTP 500;
- HTTP 502;
- HTTP 503;
- HTTP 504.

Umumnya tidak retry berulang:

- HTTP 400;
- HTTP 401;
- HTTP 403;
- HTTP 404;
- halaman terblokir permanen;
- parsing error deterministik.

`Retry-After` memberi petunjuk berapa lama client sebaiknya menunggu sebelum mencoba kembali. [R6]

## 13.5 Exponential backoff

Contoh:

```text
attempt 1: 10 detik
attempt 2: 30 detik
attempt 3: 2 menit
attempt 4: 10 menit
attempt 5: dead-letter
```

Tambahkan jitter agar banyak worker tidak retry bersamaan.

## 13.6 Circuit breaker

Circuit breaker menghentikan request sementara jika error suatu media terlalu tinggi.

State:

```text
CLOSED
→ request normal

OPEN
→ request dihentikan sementara

HALF_OPEN
→ kirim beberapa request uji
```

Contoh aturan:

```yaml
open_when:
  consecutive_failures: 20
  or_error_rate_percent: 70
  window_minutes: 10

cooldown_minutes: 15
half_open_probe_requests: 3
```

## 13.7 Redirect

Catat:

- requested URL;
- redirect chain;
- final URL;
- canonical URL.

Redirect dapat menandakan:

- perubahan slug;
- artikel dipindahkan;
- HTTP ke HTTPS;
- domain baru;
- soft paywall;
- redirect ke homepage.

Redirect ke homepage perlu ditandai sebagai invalid article fetch.

## 13.8 Conditional request

Jika server mendukung:

- `ETag`;
- `If-None-Match`;
- `Last-Modified`;
- `If-Modified-Since`.

Gunakan untuk mengurangi transfer data ketika melakukan re-crawl.

---

# 14. Parsing Halaman Artikel

## 14.1 Field minimum

Sebuah artikel dianggap dapat diproses jika memiliki:

- source ID;
- requested URL;
- final URL;
- canonical URL atau normalized final URL;
- title;
- content;
- published time atau status tanggal tidak ditemukan;
- collected time.

Kebijakan tanggal perlu jelas. Sebagian sistem mengharuskan tanggal sebagai field wajib.

## 14.2 Field yang disarankan

```text
source_id
external_article_id
requested_url
final_url
canonical_url
title
subtitle
content_text
content_html
summary
author_name
category
tags
thumbnail_url
published_at
updated_at
language
collected_at
first_discovered_at
last_seen_at
adapter_version
parser_version
content_hash
```

## 14.3 Membersihkan isi

Hapus elemen:

- iklan;
- navigasi;
- artikel terkait;
- tombol share;
- caption yang duplikat;
- newsletter box;
- komentar;
- script;
- style;
- widget rekomendasi;
- footer.

Jangan menghapus:

- paragraf artikel;
- heading dalam artikel;
- kutipan;
- list;
- caption penting;
- tabel;
- embed yang menjadi bagian substansi, jika scope mendukung.

## 14.4 Konten multi-page

Beberapa artikel memiliki beberapa halaman.

Crawler harus mendeteksi:

- tombol next page;
- parameter page;
- daftar halaman;
- canonical yang sama;
- bagian isi yang berulang.

Gabungkan konten sesuai urutan dan hapus bagian duplikat.

## 14.5 Live article

Live blog dapat berubah berkali-kali.

Kebijakan yang disarankan:

- simpan satu article record;
- perbarui `updated_at`;
- simpan version history;
- hitung content hash;
- re-crawl lebih sering;
- jangan membuat artikel baru untuk setiap update.

## 14.6 Artikel galeri dan video

Tentukan scope.

Jika tidak termasuk:

```text
status = ignored_by_policy
reason = unsupported_content_type
```

Jangan diam-diam membuang URL.

---

# 15. Prioritas Sumber Metadata

Gunakan fallback berlapis.

## 15.1 Urutan yang disarankan

Untuk setiap field:

1. data terstruktur yang spesifik dan valid;
2. meta tag;
3. elemen DOM artikel;
4. hint dari listing;
5. inferensi URL sebagai pilihan terakhir.

## 15.2 JSON-LD

Cari tipe:

- `NewsArticle`;
- `Article`;
- tipe turunan yang relevan.

Schema.org mendefinisikan `NewsArticle` untuk artikel berita dan menyediakan properti seperti headline, author, datePublished, dateModified, dan image. [R7]

JSON-LD dapat rusak atau tidak sinkron. Tetap lakukan validasi.

## 15.3 Open Graph dan metadata

Field yang umum:

```text
og:title
og:url
og:image
article:published_time
article:modified_time
article:author
article:section
```

## 15.4 DOM

Gunakan selector adapter.

Contoh:

```yaml
title_selectors:
  - "h1.article-title"
  - "article h1"

content_selectors:
  - "div.article-body"
  - "article .content"
```

Dukungan beberapa selector membantu transisi ketika media melakukan perubahan bertahap.

## 15.5 Conflict resolution

Contoh konflik:

```text
JSON-LD datePublished: 10:00
DOM published time:   10:05
Listing time:         10:03
```

Kebijakan harus konsisten.

Contoh:

```text
datePublished valid dari JSON-LD
→ gunakan JSON-LD

Jika JSON-LD tidak valid
→ gunakan DOM

Jika DOM tidak ada
→ gunakan listing hint dengan confidence rendah
```

Simpan provenance:

```json
{
  "published_at": "2026-07-21T03:00:00Z",
  "published_at_source": "json_ld",
  "published_at_confidence": "high"
}
```

---

# 16. Normalisasi URL dan Canonical URL

## 16.1 Tujuan

Satu artikel dapat memiliki banyak URL:

```text
http://example.com/article
https://example.com/article
https://www.example.com/article
https://example.com/article?utm_source=x
https://example.com/article?page=1
https://m.example.com/article
```

Normalisasi mengurangi duplikasi teknis.

## 16.2 Langkah normalisasi

1. resolve relative URL;
2. lowercase scheme dan hostname;
3. ubah HTTP ke HTTPS hanya jika terbukti ekuivalen;
4. hapus default port;
5. normalisasi trailing slash sesuai aturan domain;
6. hapus fragment;
7. hapus tracking parameter;
8. urutkan parameter yang dipertahankan;
9. normalisasi hostname;
10. decode atau encode path secara konsisten;
11. pertahankan parameter yang memengaruhi isi.

## 16.3 Tracking parameter

Contoh yang sering dapat dihapus:

```text
utm_source
utm_medium
utm_campaign
utm_term
utm_content
fbclid
gclid
ref
source
```

Jangan menghapus semua query parameter secara otomatis.

Parameter berikut dapat memengaruhi artikel:

```text
id
article_id
page
lang
edition
```

Aturan harus per media.

## 16.4 Canonical URL

`rel="canonical"` adalah sinyal halaman mengenai URL yang dianggap utama. Google juga menjelaskan canonicalization untuk memilih URL representatif dari sekumpulan URL duplikat. [R3][R4]

Untuk sistem crawler:

- canonical adalah sinyal penting;
- canonical tidak boleh dipercaya tanpa validasi;
- canonical harus berada pada domain yang diizinkan;
- canonical tidak boleh menunjuk homepage;
- canonical tidak boleh menunjuk kategori;
- canonical cross-domain perlu kebijakan khusus.

## 16.5 Canonical resolution

Urutan yang disarankan:

```text
valid rel=canonical
→ valid og:url
→ normalized final URL
→ normalized requested URL
```

## 16.6 Simpan semua URL penting

Jangan hanya menyimpan canonical.

Simpan:

```text
requested_url
final_url
canonical_url
normalized_url
redirect_chain
```

Data tersebut dibutuhkan untuk audit.

---

# 17. Validasi Artikel

Validasi harus memisahkan artikel valid, invalid, dan belum dapat dipastikan.

## 17.1 Validasi URL

- domain diizinkan;
- URL bukan kategori;
- URL bukan search;
- URL bukan login;
- URL bukan tag;
- URL bukan halaman iklan;
- URL bukan file statis;
- URL tidak kosong.

## 17.2 Validasi response

- status HTTP sesuai;
- content type sesuai;
- body tidak kosong;
- bukan CAPTCHA;
- bukan halaman block;
- bukan soft 404;
- bukan redirect ke homepage;
- ukuran response masuk akal.

## 17.3 Validasi title

Contoh aturan:

```text
minimum_length: 10
maximum_length: 500
not_equal_to:
  - "Home"
  - "404"
  - "Access Denied"
```

## 17.4 Validasi content

Contoh:

```text
minimum_characters: 200
minimum_paragraphs: 2
maximum_boilerplate_ratio: 0.60
```

Jangan menggunakan satu threshold untuk semua jenis artikel tanpa evaluasi.

Breaking news pendek dapat memiliki konten kurang dari artikel biasa.

## 17.5 Validasi tanggal

Periksa:

- format;
- timezone;
- tanggal tidak terlalu jauh di masa depan;
- tanggal tidak mustahil;
- `updated_at >= published_at`;
- tanggal listing tidak berbeda ekstrem tanpa alasan.

## 17.6 Confidence score

Opsional, tetapi berguna.

Contoh:

```text
title ditemukan:             +20
content > 500 karakter:      +25
canonical valid:             +15
published_at valid:          +20
JSON-LD NewsArticle valid:   +10
author ditemukan:             +5
category ditemukan:           +5
```

Keputusan:

```text
80–100: valid
60–79:  valid_with_warning
40–59:  manual_review
0–39:   invalid
```

Confidence score bukan pengganti aturan wajib.

---

# 18. Deduplikasi

Deduplikasi perlu dilakukan pada beberapa tingkat.

## 18.1 Tingkat 1 — Normalized URL

```text
normalized_url sama
→ kandidat duplikat kuat
```

## 18.2 Tingkat 2 — Canonical URL

```text
canonical_url sama
→ artikel yang sama
```

## 18.3 Tingkat 3 — External article ID

Jika API menyediakan ID:

```text
source_id + external_article_id
```

Ini biasanya kuat.

## 18.4 Tingkat 4 — Redirect destination

Dua URL yang berakhir pada final URL sama adalah kandidat duplikat.

## 18.5 Tingkat 5 — Content fingerprint

Gunakan hash isi yang sudah dibersihkan.

Contoh:

```text
SHA-256(normalized title + normalized content)
```

Gunakan untuk mendeteksi:

- URL berbeda untuk artikel sama;
- perubahan slug;
- mobile dan desktop URL;
- artikel yang diterbitkan ulang.

## 18.6 Near duplicate

Near duplicate membutuhkan metode seperti:

- SimHash;
- MinHash;
- cosine similarity;
- title similarity;
- content shingling.

Gunakan secara hati-hati karena dua media dapat menerbitkan berita yang sangat mirip tetapi tetap dianggap artikel berbeda.

Kunci deduplikasi harus mempertimbangkan tujuan bisnis.

### Deduplikasi dalam satu media

Biasanya agresif.

### Deduplikasi antar media

Biasanya jangan digabung menjadi satu article record. Simpan sebagai artikel berbeda dan buat hubungan `same_story_cluster` jika diperlukan.

## 18.7 Artikel update vs artikel baru

Jika canonical sama dan content hash berubah:

```text
update artikel lama
+ simpan revision
```

Jika canonical berubah tetapi external ID sama:

```text
update URL dan simpan alias
```

---

# 19. Penyimpanan Data

Pisahkan data discovery, fetch, artikel, dan audit.

## 19.1 Tabel `sources`

```sql
CREATE TABLE sources (
    source_id               TEXT PRIMARY KEY,
    display_name            TEXT NOT NULL,
    base_url                TEXT NOT NULL,
    adapter_version         TEXT NOT NULL,
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    timezone                TEXT NOT NULL,
    crawl_interval_minutes  INTEGER NOT NULL,
    overlap_hours           INTEGER NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 19.2 Tabel `discovered_urls`

```sql
CREATE TABLE discovered_urls (
    discovery_id        BIGSERIAL PRIMARY KEY,
    source_id           TEXT NOT NULL REFERENCES sources(source_id),
    raw_url             TEXT NOT NULL,
    normalized_url      TEXT NOT NULL,
    discovery_channel   TEXT NOT NULL,
    discovery_page      TEXT,
    listing_title       TEXT,
    published_hint      TIMESTAMPTZ,
    first_discovered_at TIMESTAMPTZ NOT NULL,
    last_discovered_at  TIMESTAMPTZ NOT NULL,
    discovery_count     INTEGER NOT NULL DEFAULT 1,
    UNIQUE (source_id, normalized_url, discovery_channel)
);
```

## 19.3 Tabel `fetch_attempts`

```sql
CREATE TABLE fetch_attempts (
    fetch_id            BIGSERIAL PRIMARY KEY,
    source_id           TEXT NOT NULL,
    normalized_url      TEXT NOT NULL,
    attempted_at        TIMESTAMPTZ NOT NULL,
    attempt_number      INTEGER NOT NULL,
    http_status         INTEGER,
    response_time_ms    INTEGER,
    response_bytes      INTEGER,
    final_url           TEXT,
    error_type          TEXT,
    error_message       TEXT,
    retry_scheduled_at  TIMESTAMPTZ
);
```

## 19.4 Tabel `articles`

```sql
CREATE TABLE articles (
    article_id              BIGSERIAL PRIMARY KEY,
    source_id               TEXT NOT NULL REFERENCES sources(source_id),
    external_article_id     TEXT,
    requested_url           TEXT NOT NULL,
    final_url               TEXT NOT NULL,
    canonical_url           TEXT NOT NULL,
    normalized_url          TEXT NOT NULL,
    title                   TEXT NOT NULL,
    subtitle                TEXT,
    content_text            TEXT NOT NULL,
    content_html            TEXT,
    author_name             TEXT,
    category                TEXT,
    tags                    JSONB,
    thumbnail_url           TEXT,
    published_at            TIMESTAMPTZ,
    updated_at_source       TIMESTAMPTZ,
    first_discovered_at     TIMESTAMPTZ NOT NULL,
    collected_at            TIMESTAMPTZ NOT NULL,
    last_seen_at            TIMESTAMPTZ NOT NULL,
    content_hash            TEXT NOT NULL,
    adapter_version         TEXT NOT NULL,
    parser_version          TEXT NOT NULL,
    validation_status       TEXT NOT NULL,
    validation_warnings     JSONB,
    UNIQUE (source_id, canonical_url)
);
```

## 19.5 Tabel `article_revisions`

```sql
CREATE TABLE article_revisions (
    revision_id         BIGSERIAL PRIMARY KEY,
    article_id          BIGINT NOT NULL REFERENCES articles(article_id),
    content_hash        TEXT NOT NULL,
    title               TEXT NOT NULL,
    content_text        TEXT NOT NULL,
    captured_at         TIMESTAMPTZ NOT NULL,
    parser_version      TEXT NOT NULL
);
```

## 19.6 Tabel `processing_status`

Setiap URL harus memiliki status akhir atau status aktif.

```text
discovered
queued
fetching
retry_scheduled
fetched
parsed
valid
stored
duplicate
invalid
blocked
ignored_by_policy
dead_letter
```

## 19.7 Unique constraint

Jangan hanya mengandalkan pengecekan aplikasi.

Gunakan unique constraint di database untuk mencegah race condition.

---

# 20. Scheduling dan Overlapping Crawl Window

## 20.1 Interval crawl

Contoh awal:

| Jenis media | Interval |
|---|---:|
| Breaking news tinggi | 5 menit |
| News umum | 10–15 menit |
| Media niche | 30–60 menit |

Sesuaikan dengan:

- volume publikasi;
- kebutuhan freshness;
- kemampuan server;
- rate limit;
- kebijakan website.

## 20.2 Overlap window

Setiap run memeriksa kembali artikel beberapa waktu ke belakang.

Contoh:

```yaml
crawl_interval_minutes: 10
overlap_hours: 72
```

Artinya:

- crawl berjalan setiap 10 menit;
- listing dipindai sampai artikel yang lebih tua dari 72 jam;
- URL lama dapat ditemukan lagi;
- deduplikasi mencegah record ganda.

## 20.3 Mengapa 2–3 hari

Jendela 2–3 hari cukup umum sebagai titik awal karena:

- artikel baru masih ada di listing awal;
- keterlambatan discovery dapat dipulihkan;
- perubahan kategori masih dapat ditemukan;
- News Sitemap berfokus pada artikel baru hingga sekitar dua hari. [R2]

Namun angka final harus berdasarkan audit media.

## 20.4 Adaptive scheduling

Naikkan frekuensi ketika:

- jam publikasi sibuk;
- breaking news;
- volume meningkat;
- artikel baru ditemukan setiap run.

Turunkan frekuensi ketika:

- malam hari;
- tidak ada artikel baru;
- media lambat;
- circuit breaker aktif.

## 20.5 Watermark

Simpan watermark sebagai informasi, bukan satu-satunya filter.

Contoh:

```text
latest_published_at_seen
latest_external_id_seen
last_successful_discovery_at
```

Jangan menggunakan:

```text
ambil hanya artikel dengan published_at > watermark
```

secara mutlak, karena artikel dapat terlambat muncul atau memiliki tanggal salah.

---

# 21. Rekonsiliasi dan Coverage Audit

Ini bagian terpenting untuk mengetahui apakah sistem kehilangan artikel.

## 21.1 Rekonsiliasi URL discovery

Bandingkan kumpulan URL.

```text
A = URL dari Latest
B = URL dari kategori
C = URL dari API
D = URL dari RSS
E = URL dari sitemap

Union = A ∪ B ∪ C ∪ D ∪ E
```

Analisis:

```text
only_in_latest
only_in_categories
only_in_api
only_in_rss
only_in_sitemap
not_yet_fetched
fetch_failed
parse_failed
stored
```

## 21.2 Coverage proxy

Karena jumlah artikel internal publisher tidak diketahui, gunakan proxy.

Contoh:

```text
coverage_proxy =
stored_valid_urls / union_of_observed_valid_article_urls
```

Ini bukan coverage absolut terhadap seluruh database publisher. Ini coverage terhadap URL yang berhasil diamati dari seluruh jalur yang tersedia.

## 21.3 Funnel audit

Contoh:

```text
URL ditemukan:            1.000
URL lolos filter:           950
Fetch berhasil:             940
Parse berhasil:             925
Valid:                      910
Stored baru:                300
Duplicate/update:           610
Gagal permanen:              15
Tanpa status akhir:           0
```

## 21.4 Audit listing-to-storage

Setiap URL artikel yang terlihat pada listing harus dapat ditelusuri ke status akhir.

Query konseptual:

```sql
SELECT
    d.normalized_url,
    d.discovery_channel,
    p.status,
    p.reason
FROM discovered_urls d
LEFT JOIN processing_status p
    ON p.source_id = d.source_id
   AND p.normalized_url = d.normalized_url
WHERE d.source_id = 'media_a'
  AND d.last_discovered_at >= NOW() - INTERVAL '72 hours'
  AND p.status IS NULL;
```

Targetnya adalah nol.

## 21.5 Audit manual

Otomatisasi tetap perlu sampling manual.

Prosedur:

1. pilih satu periode dua jam;
2. buka halaman Latest dan kategori;
3. catat semua artikel;
4. cocokkan dengan database;
5. hitung missing;
6. klasifikasikan penyebab;
7. perbaiki adapter atau kebijakan.

## 21.6 Gold sample

Simpan daftar artikel yang harus ditemukan oleh adapter.

Contoh fixture:

```yaml
sample_date: 2026-07-20
expected_articles:
  - url: https://news-a.example/article-1
  - url: https://news-a.example/article-2
  - url: https://news-a.example/article-3
```

Jalankan ulang pada regression test.

## 21.7 Penyebab coverage rendah

- kategori tidak lengkap;
- pagination berhenti terlalu cepat;
- artikel pinned membuat loop;
- selector kehilangan card tipe baru;
- URL filter terlalu ketat;
- API pagination salah;
- timezone salah;
- artikel pendek dianggap invalid;
- canonical salah;
- retry tidak berjalan;
- request terblokir;
- data ditemukan tetapi queue gagal;
- duplicate logic terlalu agresif.

## 21.8 Dashboard coverage per media

Minimal tampilkan:

```text
artikel ditemukan per channel
union URL
fetch success rate
parse success rate
validation success rate
dead-letter count
only-in-secondary count
time since last article
time since last successful crawl
```

---

# 22. Monitoring, Alert, dan Observability

## 22.1 Logging terstruktur

Contoh:

```json
{
  "event": "article_parse_failed",
  "source_id": "media_a",
  "url": "https://news-a.example/article-123",
  "adapter_version": "media_a_v2",
  "error_type": "content_selector_not_found",
  "attempt": 1,
  "timestamp": "2026-07-21T10:00:00Z"
}
```

## 22.2 Metrics

### Discovery

```text
discovery_runs_total
discovery_urls_total
discovery_unique_urls_total
discovery_duration_seconds
```

### Fetch

```text
fetch_requests_total
fetch_success_total
fetch_http_errors_total
fetch_timeout_total
fetch_response_time_seconds
```

### Parsing

```text
parse_success_total
parse_failure_total
empty_content_total
missing_title_total
missing_date_total
```

### Pipeline

```text
queue_depth
processing_latency_seconds
dead_letter_total
stored_articles_total
duplicate_articles_total
```

### Coverage

```text
union_urls_total
only_in_secondary_total
unprocessed_discovered_urls_total
coverage_proxy
```

## 22.3 Alert kritis

Kirim alert jika:

- tidak ada artikel ditemukan padahal biasanya ada;
- parse success turun;
- seluruh artikel kehilangan content;
- HTTP 403 atau 429 meningkat;
- response berubah menjadi CAPTCHA;
- queue menumpuk;
- dead-letter meningkat;
- adapter tidak berhasil selama beberapa run;
- jumlah artikel turun drastis dibanding baseline;
- canonical tiba-tiba menunjuk domain lain;
- response size berubah ekstrem.

## 22.4 Baseline

Bandingkan volume dengan histori yang setara.

Contoh:

```text
Senin pukul 08:00–09:00
dibandingkan median Senin empat minggu sebelumnya
```

Jangan selalu membandingkan dengan satu jam sebelumnya karena pola penerbitan dapat berbeda.

## 22.5 Health status per media

```text
HEALTHY
DEGRADED
FAILING
PAUSED
MAINTENANCE
```

---

# 23. Testing Strategy

## 23.1 Unit test

Uji fungsi kecil:

- URL normalization;
- date parsing;
- canonical validation;
- tracking parameter removal;
- URL pattern filter;
- content cleanup;
- hash generation.

## 23.2 Fixture test

Gunakan HTML atau JSON yang disimpan.

```text
fixtures/
└── media_a/
    ├── latest_page_1.html
    ├── category_business.html
    ├── article_normal.html
    ├── article_without_author.html
    ├── article_live.html
    └── blocked_page.html
```

## 23.3 Contract test

Jalankan terhadap website live dalam jumlah request kecil.

Periksa:

- endpoint masih aktif;
- selector masih menghasilkan item;
- field penting masih tersedia;
- response schema tidak berubah.

## 23.4 Integration test

Uji alur:

```text
fixture listing
→ discovery
→ queue
→ fixture article
→ parse
→ validation
→ dedup
→ database
```

## 23.5 Regression test

Setiap perubahan adapter harus membuktikan bahwa:

- artikel lama masih dapat diparse;
- artikel baru dapat diparse;
- URL non-artikel tidak masuk;
- deduplikasi tetap benar;
- coverage fixture tidak turun.

## 23.6 Canary release

Jalankan adapter baru pada sebagian pekerjaan.

Contoh:

```text
90% media_a_v1
10% media_a_v2
```

Bandingkan:

- jumlah URL;
- parse success;
- field completeness;
- error;
- content hash.

## 23.7 Snapshot test

Snapshot berguna untuk struktur hasil parser, tetapi jangan terlalu sensitif terhadap whitespace.

---

# 24. Penanganan Perubahan Website

Website berita akan berubah.

Perubahan umum:

- class CSS berubah;
- struktur card berubah;
- halaman Latest pindah;
- pagination berubah;
- API response berubah;
- JSON-LD dihapus;
- domain berubah;
- artikel video memiliki template baru;
- halaman menggunakan rendering client-side.

## 24.1 Deteksi otomatis

Gunakan indikator:

- selector result menjadi nol;
- response size berubah;
- title hilang;
- content length turun;
- DOM fingerprint berubah;
- JSON schema validation gagal;
- parse success turun;
- volume discovery turun.

## 24.2 Multiple selector fallback

Contoh:

```yaml
content_selectors:
  - "div.article-body-v2"
  - "div.article-body"
  - "article .content"
```

Fallback membantu migrasi, tetapi jangan mempertahankan selector lama selamanya tanpa audit.

## 24.3 DOM fingerprint

Simpan fingerprint struktur elemen penting, bukan seluruh HTML.

Contoh:

```text
article
 ├── header
 │   ├── h1
 │   └── time
 └── div.article-body
```

Perubahan signifikan memicu alert.

## 24.4 Prosedur perbaikan

1. pause adapter jika membebani situs;
2. simpan sampel response gagal;
3. identifikasi perubahan;
4. perbarui fixture;
5. perbarui adapter;
6. jalankan unit dan regression test;
7. jalankan shadow mode;
8. canary;
9. production;
10. lakukan backfill periode terdampak.

## 24.5 Jangan menghapus bukti error

Simpan:

- timestamp;
- URL;
- status;
- sebagian response yang aman;
- response hash;
- adapter version;
- stack trace;
- screenshot hanya jika browser rendering digunakan dan sesuai kebijakan.

---

# 25. Error Handling dan Recovery

## 25.1 Klasifikasi error

### Transient

Kemungkinan pulih:

- timeout;
- connection reset;
- 429;
- 500;
- 502;
- 503;
- 504.

### Persistent source error

- selector rusak;
- API berubah;
- CAPTCHA;
- domain berubah;
- seluruh response kosong.

### Data error

- tanggal invalid;
- title kosong;
- content terlalu pendek;
- canonical salah.

### Policy error

- robots tidak mengizinkan;
- paywall;
- autentikasi;
- tipe konten tidak masuk scope.

## 25.2 Dead-letter queue

URL masuk dead-letter setelah batas retry.

Data yang disimpan:

```text
source_id
url
first_failed_at
last_failed_at
attempt_count
last_error_type
last_error_message
adapter_version
response_reference
```

## 25.3 Replay

Engineer harus dapat menjalankan ulang:

- satu URL;
- seluruh dead-letter satu media;
- rentang waktu;
- versi adapter tertentu;
- artikel dengan parser lama.

## 25.4 Idempotency key

Contoh:

```text
source_id + normalized_url
```

Atau:

```text
source_id + external_article_id
```

## 25.5 Poison message

Jika satu URL selalu merusak worker:

- batasi attempt;
- pindahkan ke dead-letter;
- jangan block queue;
- investigasi terpisah.

---

# 26. Backfill Artikel Lama

Backfill adalah proses mengambil histori artikel.

## 26.1 Sumber backfill

Urutan yang dapat digunakan:

1. sitemap index;
2. sitemap arsip;
3. category pagination;
4. archive page;
5. API dengan date range;
6. search internal website;
7. daftar bulanan atau tahunan.

## 26.2 Pisahkan workload

Jangan menjalankan backfill pada queue yang sama dengan artikel terbaru tanpa prioritas.

```text
high priority: fresh discovery
low priority: backfill
```

## 26.3 Checkpoint

Simpan:

```text
source_id
backfill_strategy
current_page
current_cursor
date_from
date_to
last_success_at
```

## 26.4 Throttling

Backfill menghasilkan banyak request. Gunakan rate limit lebih rendah daripada fresh crawl.

## 26.5 Deduplikasi tetap berlaku

Backfill dapat menemukan artikel yang sudah ada dari fresh crawler.

---

# 27. Keamanan, Etika, dan Kepatuhan

## 27.1 Robots.txt

Periksa robots.txt sesuai kebijakan organisasi dan standar RFC 9309. [R5]

Simpan hasil evaluasi:

```text
allowed
disallowed
unknown
temporarily_unavailable
```

## 27.2 Terms of Service

robots.txt bukan satu-satunya pertimbangan.

Periksa:

- syarat penggunaan;
- lisensi;
- hak cipta;
- kebijakan API;
- larangan automated access;
- penggunaan komersial;
- aturan penyimpanan konten.

## 27.3 Paywall dan autentikasi

Jangan:

- melewati paywall;
- memakai kredensial tanpa izin;
- mengambil token pengguna;
- mengakali kontrol akses;
- mengambil endpoint yang tidak publik.

## 27.4 Data minimization

Jika kebutuhan hanya:

- judul;
- URL;
- waktu;
- ringkasan;

jangan otomatis menyimpan seluruh HTML.

## 27.5 Contact dan opt-out

Untuk crawler production, pertimbangkan menyediakan:

- halaman informasi crawler;
- alamat kontak;
- mekanisme pemilik situs menghubungi operator;
- prosedur pause atau block source.

## 27.6 Rate yang sopan

Jangan mengukur keberhasilan dari jumlah request maksimum.

Tujuannya mengambil data dengan dampak minimum.

---

# 28. Contoh End-to-End: Media HTML

Gunakan media fiktif `Media Nusantara Daily`.

## 28.1 Hasil analisis

```text
Latest:
https://mnd.example/latest

Categories:
https://mnd.example/nasional
https://mnd.example/bisnis
https://mnd.example/teknologi

Pagination:
?page=N

Article card:
.article-card

Article link:
.article-card h2 a

Article title:
h1.article-title

Content:
div.article-content

Published:
time[datetime]

Canonical:
link[rel=canonical]
```

## 28.2 Source profile

```yaml
source_id: media_nusantara_daily
adapter_version: mnd_v1
base_url: https://mnd.example
timezone: Asia/Jakarta

schedule:
  interval_minutes: 10
  overlap_hours: 72

discovery:
  latest:
    url: https://mnd.example/latest
    max_pages: 8

  categories:
    urls:
      - https://mnd.example/nasional
      - https://mnd.example/bisnis
      - https://mnd.example/teknologi
    max_pages_per_category: 5

article:
  link_selector: ".article-card h2 a"
  title_selector: "h1.article-title"
  content_selector: "div.article-content"
  published_selector: "time[datetime]"
  canonical_selector: "link[rel=canonical]"
```

## 28.3 Discovery run

```text
10:00 Scheduler memilih source
10:00 Latest page 1–8 dipindai
10:01 Tiga kategori dipindai
10:02 130 raw URL ditemukan
10:02 118 normalized URL unik
10:02 12 URL sudah diproses
10:02 106 URL masuk queue
```

## 28.4 Fetch dan parse

Untuk setiap URL:

1. cek robots policy;
2. rate limit;
3. request;
4. simpan status;
5. resolve redirect;
6. ambil canonical;
7. ambil JSON-LD;
8. ambil DOM;
9. bersihkan content;
10. validasi;
11. dedup;
12. simpan.

## 28.5 Rekonsiliasi

Hasil:

```text
Latest:      102
Categories:  116
RSS:          78
Sitemap:     110
Union:       118
```

Ditemukan dua artikel yang hanya muncul di kategori.

Tindakan:

- pastikan keduanya valid;
- simpan;
- tandai `only_in_categories`;
- pantau apakah pola tersebut normal;
- jangan menganggap Latest gagal jika memang desain media demikian.

## 28.6 Alert contoh

```text
Media Nusantara Daily:
parse success turun dari 99,1% menjadi 42,7%.
Content selector tidak ditemukan pada 57 artikel.
Kemungkinan template artikel berubah.
```

---

# 29. Contoh End-to-End: Media JavaScript

Gunakan media fiktif `Digital News Network`.

## 29.1 Observasi

HTML awal hanya memuat shell.

Network menunjukkan request:

```text
GET https://dnn.example/api/v2/articles?section=latest&limit=30&cursor=...
```

Response:

```json
{
  "data": [
    {
      "articleId": "DN-98231",
      "url": "/articles/ekonomi-baru",
      "headline": "Ekonomi Baru",
      "publishedAt": "2026-07-21T08:30:00Z"
    }
  ],
  "nextCursor": "abc123"
}
```

## 29.2 Strategi

Primary discovery:

- Latest API;
- Category API.

Secondary:

- sitemap;
- RSS.

Article parsing:

- HTML server-rendered article;
- JSON-LD;
- DOM fallback.

## 29.3 Adapter

```python
class DigitalNewsNetworkAdapter(SourceAdapter):
    source_id = "digital_news_network"

    def discover(self, context):
        for section in ["latest", "business", "technology"]:
            yield from self._discover_section(context, section)

    def _discover_section(self, context, section):
        cursor = None

        while True:
            response = context.http.get(
                "https://dnn.example/api/v2/articles",
                params={
                    "section": section,
                    "limit": 30,
                    "cursor": cursor
                }
            )

            payload = response.json()

            for item in payload["data"]:
                yield DiscoveryItem(
                    url=context.absolute_url(item["url"]),
                    external_id=item["articleId"],
                    published_hint=item["publishedAt"],
                    channel=f"api:{section}"
                )

            cursor = payload.get("nextCursor")

            if not cursor:
                break
```

## 29.4 Schema validation

```json
{
  "type": "object",
  "required": ["data"],
  "properties": {
    "data": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["articleId", "url", "headline"]
      }
    }
  }
}
```

Jika field berubah dari `articleId` menjadi `id`, contract test gagal sebelum seluruh pipeline rusak diam-diam.

## 29.5 Fallback

Jika API gagal:

1. coba HTML listing;
2. coba sitemap;
3. jangan langsung memakai browser automation;
4. alert jika primary discovery gagal;
5. lanjutkan media lain.

---

# 30. Struktur Project Referensi

```text
reliable-news-crawler/
├── app/
│   ├── core/
│   │   ├── scheduler.py
│   │   ├── orchestrator.py
│   │   ├── http_client.py
│   │   ├── robots_policy.py
│   │   ├── retry.py
│   │   ├── rate_limiter.py
│   │   ├── circuit_breaker.py
│   │   ├── url_normalizer.py
│   │   ├── validator.py
│   │   ├── deduplicator.py
│   │   └── storage.py
│   │
│   ├── adapters/
│   │   ├── base.py
│   │   ├── media_a/
│   │   │   ├── adapter.py
│   │   │   ├── profile.yaml
│   │   │   └── selectors.yaml
│   │   └── media_b/
│   │       ├── adapter.py
│   │       ├── profile.yaml
│   │       └── selectors.yaml
│   │
│   ├── discovery/
│   │   ├── html_listing.py
│   │   ├── api_listing.py
│   │   ├── rss.py
│   │   ├── sitemap.py
│   │   └── reconciliation.py
│   │
│   ├── parsing/
│   │   ├── json_ld.py
│   │   ├── metadata.py
│   │   ├── dom.py
│   │   ├── content_cleaner.py
│   │   └── date_parser.py
│   │
│   ├── monitoring/
│   │   ├── metrics.py
│   │   ├── alerts.py
│   │   └── health.py
│   │
│   └── models/
│       ├── discovery.py
│       ├── article.py
│       └── errors.py
│
├── config/
│   ├── sources.yaml
│   └── defaults.yaml
│
├── fixtures/
│   ├── media_a/
│   └── media_b/
│
├── tests/
│   ├── unit/
│   ├── fixtures/
│   ├── integration/
│   └── contract/
│
├── migrations/
├── scripts/
│   ├── replay_url.py
│   ├── backfill.py
│   ├── audit_coverage.py
│   └── validate_source.py
│
├── dashboards/
├── runbooks/
└── README.md
```

---

# 31. Kontrak Adapter Referensi

## 31.1 Model discovery

```python
@dataclass
class DiscoveryItem:
    url: str
    channel: str
    external_id: str | None = None
    title_hint: str | None = None
    published_hint: datetime | None = None
    category_hint: str | None = None
    metadata: dict = field(default_factory=dict)
```

## 31.2 Model artikel

```python
@dataclass
class ParsedArticle:
    source_id: str
    requested_url: str
    final_url: str
    canonical_url: str | None
    external_id: str | None
    title: str | None
    content_text: str | None
    content_html: str | None
    published_at: datetime | None
    updated_at: datetime | None
    author_name: str | None
    category: str | None
    tags: list[str]
    thumbnail_url: str | None
    language: str | None
    field_provenance: dict
```

## 31.3 Interface adapter

```python
class SourceAdapter(Protocol):
    source_id: str
    adapter_version: str

    def discover(
        self,
        context: CrawlContext
    ) -> Iterable[DiscoveryItem]:
        ...

    def parse_article(
        self,
        response: FetchResponse,
        item: DiscoveryItem,
        context: CrawlContext
    ) -> ParsedArticle:
        ...

    def normalize_url(
        self,
        url: str,
        context: CrawlContext
    ) -> str:
        ...

    def is_article_url(
        self,
        url: str,
        context: CrawlContext
    ) -> bool:
        ...
```

## 31.4 Core processing

```python
def run_source(source):
    adapter = adapter_registry.load(source.adapter_version)

    for item in adapter.discover(context_for(source)):
        normalized_url = adapter.normalize_url(item.url, context_for(source))

        record_discovery(
            source_id=source.source_id,
            item=item,
            normalized_url=normalized_url
        )

        if not adapter.is_article_url(normalized_url, context_for(source)):
            mark_ignored(normalized_url, "not_article_url")
            continue

        enqueue_article(
            source_id=source.source_id,
            normalized_url=normalized_url,
            discovery_item=item
        )
```

## 31.5 Article worker

```python
def process_article(job):
    try:
        response = fetch_with_policy(job)
        article = job.adapter.parse_article(
            response=response,
            item=job.discovery_item,
            context=job.context
        )

        article = resolve_canonical(article)
        validation = validate_article(article)

        if not validation.accepted:
            mark_invalid(job, validation)
            return

        duplicate = find_duplicate(article)

        if duplicate:
            update_existing_article(duplicate, article)
            mark_duplicate(job, duplicate.article_id)
            return

        store_article(article)
        mark_stored(job)

    except RetryableError as error:
        schedule_retry(job, error)

    except PermanentError as error:
        move_to_dead_letter(job, error)
```

## 31.6 Adapter anti-pattern

Hindari:

```python
if source == "media_a":
    selector = ".content-a"
elif source == "media_b":
    selector = "#content-b"
elif source == "media_c":
    selector = "article .body"
```

Gunakan registry:

```python
adapter = adapter_registry.load(source.adapter_version)
article = adapter.parse_article(...)
```

---

# 32. Checklist Production Readiness

## 32.1 Source onboarding

- [ ] Terms dan robots diperiksa.
- [ ] Latest/All News ditemukan.
- [ ] Seluruh kategori dalam scope dicatat.
- [ ] Pagination diuji.
- [ ] API frontend diperiksa.
- [ ] RSS dicatat.
- [ ] News Sitemap dicatat.
- [ ] Sitemap umum dicatat.
- [ ] Pola URL artikel dibuat.
- [ ] Exclusion pattern dibuat.
- [ ] Source profile disimpan.
- [ ] Timezone dikonfirmasi.
- [ ] Rate limit ditentukan.
- [ ] Overlap window ditentukan.

## 32.2 Discovery

- [ ] Latest berhasil menghasilkan URL.
- [ ] Kategori berhasil menghasilkan URL.
- [ ] Pagination tidak loop.
- [ ] Stop condition diuji.
- [ ] Relative URL di-resolve.
- [ ] URL eksternal difilter.
- [ ] Discovery channel disimpan.
- [ ] URL yang sama dapat ditemukan berulang tanpa duplikasi.

## 32.3 Parsing

- [ ] Title berhasil.
- [ ] Content berhasil.
- [ ] Published time berhasil atau memiliki kebijakan fallback.
- [ ] Canonical divalidasi.
- [ ] Author opsional ditangani.
- [ ] Gambar opsional ditangani.
- [ ] JSON-LD diuji.
- [ ] DOM fallback diuji.
- [ ] Halaman block terdeteksi.
- [ ] Soft 404 terdeteksi.
- [ ] Artikel pendek ditangani.
- [ ] Live article ditangani.

## 32.4 Reliability

- [ ] Retry aktif.
- [ ] Backoff aktif.
- [ ] `Retry-After` dihormati.
- [ ] Circuit breaker aktif.
- [ ] Dead-letter queue tersedia.
- [ ] Replay tersedia.
- [ ] Unique constraint tersedia.
- [ ] Queue bersifat idempotent.
- [ ] Satu media tidak dapat menghentikan media lain.

## 32.5 Coverage

- [ ] Union antarjalur dihitung.
- [ ] `only_in_secondary` dihitung.
- [ ] URL tanpa status akhir terdeteksi.
- [ ] Audit manual dilakukan.
- [ ] Baseline volume tersedia.
- [ ] Coverage dashboard tersedia.
- [ ] Alert volume nol tersedia.

## 32.6 Testing

- [ ] Unit test.
- [ ] Fixture test.
- [ ] Contract test.
- [ ] Integration test.
- [ ] Regression test.
- [ ] Shadow run.
- [ ] Canary release.

## 32.7 Operations

- [ ] Source dapat dipause.
- [ ] Adapter memiliki versi.
- [ ] Parser memiliki versi.
- [ ] Log terstruktur.
- [ ] Metrics per media.
- [ ] Alert memiliki owner.
- [ ] Runbook tersedia.
- [ ] Backfill procedure tersedia.
- [ ] Prosedur perubahan website tersedia.

---

# 33. Runbook Operasional

## 33.1 Kasus: Artikel tiba-tiba nol

1. cek apakah media memang menerbitkan artikel;
2. cek HTTP status listing;
3. cek robots;
4. cek selector;
5. cek API response;
6. cek pagination;
7. cek queue;
8. cek source enabled;
9. cek circuit breaker;
10. simpan fixture baru;
11. pause jika request berulang tidak berguna;
12. perbaiki adapter;
13. jalankan backfill periode terdampak.

## 33.2 Kasus: Banyak artikel tanpa content

1. cek apakah template berubah;
2. cek content selector;
3. cek JSON-LD;
4. cek apakah response adalah consent page;
5. cek apakah website menjadi client-rendered;
6. cek response body;
7. perbarui adapter;
8. jalankan regression test;
9. replay URL gagal.

## 33.3 Kasus: HTTP 429 meningkat

1. hentikan concurrency tambahan;
2. baca `Retry-After`;
3. turunkan request rate;
4. aktifkan circuit breaker;
5. periksa apakah backfill berjalan bersamaan;
6. pisahkan fresh crawl dan backfill;
7. pantau pemulihan.

## 33.4 Kasus: Banyak duplikat

1. periksa URL normalization;
2. periksa canonical;
3. periksa mobile URL;
4. periksa tracking parameter;
5. periksa redirect;
6. periksa unique constraint;
7. periksa external ID;
8. merge alias jika aman.

## 33.5 Kasus: Artikel hanya ditemukan di sitemap

1. validasi bahwa URL adalah artikel;
2. cek apakah ada kategori yang belum dipantau;
3. cek tipe konten;
4. cek URL filter;
5. cek pagination depth;
6. cek apakah listing menggunakan API lain;
7. putuskan apakah ini pola normal atau gap adapter.

## 33.6 Kasus: Perubahan adapter menyebabkan coverage turun

1. rollback adapter;
2. bandingkan hasil versi lama dan baru;
3. jalankan gold sample;
4. periksa field completeness;
5. perbaiki;
6. shadow mode;
7. canary ulang;
8. backfill periode perubahan.

---

# 34. Glosarium

**Adapter**  
Komponen khusus yang memahami struktur satu media.

**Backfill**  
Pengambilan artikel historis.

**Canonical URL**  
URL yang dinyatakan atau dipilih sebagai representasi utama sebuah halaman.

**Circuit Breaker**  
Mekanisme penghentian request sementara ketika error terlalu tinggi.

**Coverage Proxy**  
Perkiraan coverage berdasarkan seluruh URL yang berhasil diamati dari jalur discovery yang tersedia.

**Dead-letter Queue**  
Tempat pekerjaan yang gagal permanen setelah batas retry.

**Discovery**  
Proses menemukan URL kandidat artikel.

**Discovery Channel**  
Jalur tempat URL ditemukan, misalnya Latest, kategori, RSS, atau sitemap.

**Fixture**  
Salinan contoh HTML atau JSON untuk testing.

**Idempotent**  
Pemrosesan berulang memberikan hasil akhir yang sama tanpa membuat duplikat.

**Listing Page**  
Halaman yang menampilkan daftar artikel.

**Normalized URL**  
URL yang telah dibersihkan dan diseragamkan.

**Overlap Window**  
Jangka waktu sebelumnya yang diperiksa ulang pada setiap crawl.

**Parser**  
Komponen yang mengubah HTML atau JSON menjadi data artikel.

**Reconciliation**  
Proses membandingkan hasil antarjalur dan status pemrosesan.

**Source Profile**  
Konfigurasi dan dokumentasi teknis satu media.

**Watermark**  
Penanda artikel atau waktu terbaru yang pernah diamati.

---

# 35. Referensi Resmi

## R1 — Google Search Central: What Is a Sitemap

Google menjelaskan fungsi sitemap sebagai bantuan discovery dan crawling.

https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview

## R2 — Google Search Central: Create a News Sitemap

Dokumentasi News Sitemap dan ketentuan artikel berita baru.

https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap

## R3 — Google Search Central: Canonicalization

Penjelasan mengenai canonical URL.

https://developers.google.com/search/docs/crawling-indexing/canonicalization

## R4 — Google Search Central: Specify a Canonical URL

Metode deklarasi canonical dan konsolidasi URL duplikat.

https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls

## R5 — RFC 9309: Robots Exclusion Protocol

Standar Robots Exclusion Protocol.

https://www.rfc-editor.org/rfc/rfc9309.html

## R6 — RFC 9110: HTTP Semantics

Referensi HTTP semantics, termasuk `Retry-After`.

https://www.rfc-editor.org/rfc/rfc9110.html

## R7 — Schema.org: NewsArticle

Definisi dan properti tipe data `NewsArticle`.

https://schema.org/NewsArticle

---

# Penutup

Sistem scraping berita yang reliable tidak dibangun dengan satu selector atau satu feed.

Fondasinya adalah:

```text
multi-source discovery
+ core crawler umum
+ adapter per media
+ overlapping crawl
+ idempotent processing
+ validasi
+ deduplikasi
+ rekonsiliasi
+ coverage audit
+ monitoring
+ recovery
```

Prinsip paling penting:

> **Jangan hanya memastikan crawler berjalan. Pastikan setiap URL yang terlihat memiliki jejak discovery, status pemrosesan, dan hasil yang dapat diaudit.**

Tanpa akses internal publisher, 100% completeness tidak dapat dibuktikan. Namun dengan desain dalam buku ini, engineer dapat membangun sistem yang memiliki coverage tinggi, dapat diukur, dapat dipelihara, dan dapat menunjukkan secara jelas ketika terjadi kehilangan data atau kerusakan adapter.
