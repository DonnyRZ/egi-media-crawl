# EGI Read DTO (`n5.v1`)

Read-only mapper from crawl N5 `ParsedArticle` / crawl `articles` rows to an EGI-facing
shape whose aliases align with editorial `egi-media-backend` `articles` column names
(`content`, `featured_image`, …) for **consumer convenience only**.

| | |
|---|---|
| **Module** | `src/dto/egiArticleRead.js` |
| **Export** | `toEgiArticleRead(article)` |
| **Contract** | Crawl storage remains N5 snake_case (`docs/N5_CONTRACT_LOCKED.md`) |
| **Writes** | **None** — do not INSERT/UPDATE editorial EGI DB |

---

## Mapping table

| Crawl (N5) | EGI-facing DTO | Notes |
|---|---|---|
| `content_text` | `content` | Alias; crawl column unchanged |
| `thumbnail_url` | `featured_image` | Alias; crawl column unchanged |
| `title` | `title` | Passthrough |
| `summary` | `summary` | Passthrough optional |
| `published_at` | `published_at` | Passthrough (soft-required on crawl) |
| `author_name` | `author_name` | Display **string**; NOT editorial `author_id` UUID |
| `canonical_url` (prefer) / else `normalized_url` | `source_url` | Prefer canonical |
| `category` | `category` | Optional passthrough |
| `tags` | `tags` | Optional passthrough (`string[]`) |
| `language` | `language` | Optional passthrough |
| `source_id` | `source_id` | Crawl identity |
| `external_article_id` | `external_article_id` | Crawl identity |
| `content_hash` | `content_hash` | Crawl identity |
| `collected_at` | `collected_at` | Crawl identity |
| `adapter_version` | `adapter_version` | Crawl identity |
| `field_provenance` | `field_provenance` | Optional |
| `content_html` | `content_html` | Optional |
| `subtitle` | `subtitle` | Optional |
| `updated_at_source` | `updated_at_source` | Optional |
| `requested_url` | `requested_url` | Crawl URL trail |
| `final_url` | `final_url` | Crawl URL trail |
| `normalized_url` | `normalized_url` | Also used as `source_url` fallback |
| `canonical_url` | `canonical_url` | Also preferred for `source_url` |

---

## Example JSON

Input (minimal N5 / `ParsedArticle`-like):

```json
{
  "source_id": "detik",
  "requested_url": "https://news.detik.com/berita/d-123/contoh",
  "final_url": "https://news.detik.com/berita/d-123/contoh",
  "canonical_url": "https://news.detik.com/berita/d-123/contoh",
  "normalized_url": "https://news.detik.com/berita/d-123/contoh",
  "title": "Contoh Judul",
  "content_text": "Isi artikel plain text.",
  "content_html": "<p>Isi artikel plain text.</p>",
  "summary": "Ringkasan singkat.",
  "thumbnail_url": "https://cdn.example/thumb.jpg",
  "published_at": "2026-07-24T10:00:00.000Z",
  "author_name": "Redaksi Detik",
  "category": "berita",
  "tags": ["politik"],
  "language": "id",
  "content_hash": "abc123",
  "collected_at": "2026-07-24T12:00:00.000Z",
  "adapter_version": "detik_v1",
  "field_provenance": { "published_at": { "source": "json_ld", "confidence": "high" } }
}
```

Output of `toEgiArticleRead(article)`:

```json
{
  "title": "Contoh Judul",
  "summary": "Ringkasan singkat.",
  "content": "Isi artikel plain text.",
  "featured_image": "https://cdn.example/thumb.jpg",
  "published_at": "2026-07-24T10:00:00.000Z",
  "author_name": "Redaksi Detik",
  "source_url": "https://news.detik.com/berita/d-123/contoh",
  "category": "berita",
  "tags": ["politik"],
  "language": "id",
  "source_id": "detik",
  "external_article_id": undefined,
  "content_hash": "abc123",
  "collected_at": "2026-07-24T12:00:00.000Z",
  "adapter_version": "detik_v1",
  "field_provenance": { "published_at": { "source": "json_ld", "confidence": "high" } },
  "content_html": "<p>Isi artikel plain text.</p>",
  "subtitle": undefined,
  "updated_at_source": undefined,
  "requested_url": "https://news.detik.com/berita/d-123/contoh",
  "final_url": "https://news.detik.com/berita/d-123/contoh",
  "normalized_url": "https://news.detik.com/berita/d-123/contoh",
  "canonical_url": "https://news.detik.com/berita/d-123/contoh"
}
```

*(JSON serialization drops `undefined` keys; the in-memory object still exposes the alias keys.)*

---

## Smoke

```bash
node src/dto/egiArticleRead.smoke.js
```

Expect exit code `0`.
