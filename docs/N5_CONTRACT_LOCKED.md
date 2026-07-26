# N5 Contract — LOCKED

| | |
|---|---|
| **Status** | **LOCKED** |
| **Date** | 2026-07-24 |
| **Contract version** | `n5.v1` |

This document freezes the crawl-side **Normalized Field Contract (N5)** for `ParsedArticle` and the crawl `articles` store. AI / downstream consumers should treat this shape as stable for `n5.v1`.

**Hard rule:** Crawl storage and adapters stay **snake_case**. There is **no camelCase** on `ParsedArticle` or the store layer. EGI editorial column aliases (e.g. `content`, `featured_image`) exist only on the **read-only** DTO — see `docs/EGI_READ_DTO.md` — and must never be written into the crawl DB or adapters.

This contract does **not** authorize writes to the editorial EGI database (`egi-media-backend` `articles`).

---

## Field tables

### Required (store gate rejects if missing)

| Field | Notes |
|---|---|
| `source_id` | Pipeline-guaranteed from source profile |
| `requested_url` | Pipeline-filled from URL/fetch step |
| `final_url` | Pipeline-filled from fetch |
| `canonical_url` | Adapter/bridge should supply; pipeline has defensive fallback to `normalized_url` / `final_url` |
| `normalized_url` | Pipeline-filled via `normalizeUrl` |
| `title` | Adapter/bridge must supply |
| `content_text` | Adapter/bridge must supply (plain text body) |
| `content_hash` | Pipeline-guaranteed via `computeContentHash` |
| `collected_at` | Pipeline-guaranteed (ISO 8601) |
| `adapter_version` | Pipeline-guaranteed from source profile |

### Soft-required (store does not reject; warning recorded)

| Field | Notes |
|---|---|
| `published_at` | ISO 8601. Missing → `validation_warnings` includes `missing_published_at` |

### Optional (may be omitted; no store warning)

| Field | Notes |
|---|---|
| `external_article_id` | Source-native id when available |
| `subtitle` | |
| `content_html` | Markup body when available |
| `summary` | Short dek / meta description |
| `author_name` | Display name string (not an editorial UUID) |
| `category` | |
| `tags` | `string[]` |
| `thumbnail_url` | |
| `updated_at_source` | Publisher-reported update time (ISO 8601) |
| `language` | Best-effort ISO 639-1 (e.g. `id`, `en`) |
| `parser_version` | Defaults to `adapter_version` at store if omitted |
| `field_provenance` | Per-field extraction metadata (JSONB) |

### Pipeline- / store-owned (adapters must not set)

| Field | Notes |
|---|---|
| `validation_status` | Set by validation / store (default `valid`) |
| `validation_warnings` | Built/augmented by store (e.g. `missing_published_at`) |
| `first_discovered_at` | Derived from `collected_at` on first insert |
| `last_seen_at` | Wall-clock at upsert |

---

## Naming rule

- **Snake_case only** on `ParsedArticle`, adapters, and crawl DB columns.
- Do **not** introduce camelCase mirrors on the store path (`contentText`, `thumbnailUrl`, etc.).
- Read convenience aliases for EGI consumers live in `src/dto/egiArticleRead.js` only.

---

## Brief semantics

| Concept | Meaning |
|---|---|
| `content_text` | Canonical plain-text article body used for hashing and storage. Required. |
| `content_html` | Optional HTML/markup body. Never a substitute for `content_text` at the store gate. |
| `published_at` | Soft-required publish timestamp. Absence is warned, not rejected. |
| `field_provenance` | Optional object of per-field extraction metadata, e.g. `{ published_at: { source: 'json_ld', confidence: 'high' } }`. Stored as JSONB as-is. |

---

## Change policy

| Change type | Action |
|---|---|
| **Breaking** (rename/remove required fields, change required→optional semantics that weaken the store gate, change meaning of required fields) | Bump contract version (`n5.v2`, …) and update this doc + code SoT mirrors together |
| **Non-breaking** (add optional fields, clarify docs, additive DTO aliases) | Patch OK under `n5.v1` without a version bump |

Do **not** weaken `assertStorable()` / `REQUIRED_ARTICLE_FIELDS` in `src/db/articles.js` without a contract version bump.

---

## Code sources of truth (mirrors)

| Artifact | Role |
|---|---|
| `src/core/fieldContract.js` | `REQUIRED_ARTICLE_FIELDS` / `SOFT_REQUIRED_ARTICLE_FIELDS` / `N5_OPTIONAL_FIELDS` lists |
| `src/core/types.js` | `ParsedArticle` JSDoc typedef |
| `src/db/articles.js` | Runtime store gate (`assertStorable`) — **do not weaken** |

This markdown doc freezes the contract for consumers; the three files above are the in-repo SoT mirrors. Keep them aligned when revising under a new contract version.
