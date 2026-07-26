# Sprint 2 Gap Audit

**Scope:** N5 normalized-field-contract consistency across `src/core/types.js` (typedef) ↔
`db/migrations/001_init.sql` + `002_add_summary_language_provenance.sql` (DB) ↔
`src/db/articles.js` (store) ↔ `detik`/`suara`/`viva` `coreAdapter.js` bridges.
**Method:** static read-only review, no code changes. Every claim below cites the file/line
behavior it's based on.

## matrix

Legend: **OK** = field present and consistent · **soft** = intentionally soft-required ·
**—** = field not produced/consumed at this layer (by design or gap, see notes) · **⚠** = mismatch.

| field | typedef (`src/core/types.js`) | DB (`001_init.sql`+`002_*.sql`) | store write (`src/db/articles.js`) | detik bridge | suara bridge | viva bridge | gap? |
|---|---|---|---|---|---|---|---|
| `source_id` | optional bracket L98 (pipeline-filled) | `NOT NULL` L104 | `REQUIRED_ARTICLE_FIELDS` L21, param L80 | not set (pipeline fills from `getSourceProfile().source_id`) | same | same | OK — bracket is correct here, `getSourceProfile()` always returns a real value in all 3 bridges |
| `requested_url` | required (no bracket) L100 | `NOT NULL` L106 | required L22, param L82 | not set (pipeline: `requested_url: url`) | same | same | OK |
| `final_url` | required L101 | `NOT NULL` L107 | required L23, param L83 | not set (pipeline: `fetchResult.finalUrl \|\| normalizedUrl`) | same | same | OK |
| `canonical_url` | **optional bracket** L102 | `NOT NULL` L108 | required L24, param L84 | `draft.url \|\| undefined` L74 | `draft.url \|\| undefined` L77 | `draft.canonicalUrl \|\| draft.url \|\| undefined` L107 | **⚠ P0 — see below** |
| `normalized_url` | required L103 | `NOT NULL` L109 | required L25, param L85 | not set (pipeline: `normalizeUrl()`) | same | same | OK |
| `title` | required L104 | `NOT NULL` L110 | required L26, param L86 | `draft.title` L76 | `draft.title` L78 | `draft.title` L108 | OK |
| `subtitle` | optional L105 | nullable `TEXT` L111 | optional, param L87 | **not set** (raw draft has no subtitle field) | **not set** | **not set** | note — universally unimplemented, not a cross-layer mismatch |
| `content_text` | required L106 | `NOT NULL` L112 | required L27, param L88 | `paragraphs.join('\n\n')` L70/77 | same pattern L59/79 | same pattern L102/110 | OK |
| `content_html` | optional L107 | nullable L113 | optional, param L89 | built from paragraphs L71/78 | L60/80 | L103/111 | OK |
| `summary` | optional L108 | nullable, added by 002 L12 | optional, param L90 | `draft.summary` L83 | `draft.summary` L81 | `draft.summary` L109 | OK |
| `author_name` | optional L109 | nullable L114 | optional, param L91 | `draft.author` L87 | `draft.author` L82 | `draft.author` L112 | OK |
| `category` | optional L110 | nullable L115 | optional, param L92 | `draft.category` L85 | `draft.category` L83 | `draft.category` L113 | OK |
| `tags` | optional `string[]` L111 | nullable `JSONB` + GIN index L116/140 | `JSON.stringify(tags)` param L93 | array-of-strings L86, from `.detail__body-tag a` (detik `index.js` L376/397) | array-of-strings L84, from `.article-tags a` (suara `index.js` L488/527) | **not mapped at all** | P1 — see below |
| `thumbnail_url` | optional L112 | nullable L117 | optional, param L94 | `draft.thumbnailUrl` L84 | `draft.thumbnailUrl` L85 | `draft.thumbnailUrl` L114 | OK |
| `published_at` | optional, documented **soft** L113-115 | nullable `TIMESTAMPTZ` L118 | **soft** — excluded from `REQUIRED_ARTICLE_FIELDS`; `buildValidationWarnings()` appends `missing_published_at` L46-52 | `draft.publishedAt` L88 | `draft.publishedAt` L86 | `draft.publishedAt` L115 | OK — see notes |
| `updated_at_source` | optional L116 | nullable L119 | optional, param L96 | `draft.updatedAt` L89 | `draft.updatedAt` L87 | `draft.updatedAt` L116 | OK |
| `language` | optional L117 | nullable, added by 002 L13 | optional, param L97 | hardcoded `'id'` L90 | hardcoded `'id'` L88 | hardcoded `'id'` L117 | OK — see notes |
| `external_article_id` | optional L99 | nullable L105 | optional, param L81 | `draft.externalArticleId` L75 | `draft.externalId` L76 | `draft.externalId` L106 | OK |
| `field_provenance` | optional `Object` L122-124 | nullable `JSONB`, added by 002 L14 | optional, `JSON.stringify` param L106 | **not set at all** (no key in return object) | built from `multipage`/`externalId` L62-70/90 | fully built via `buildFieldProvenance()` L73-93/119 | P1 — see below |
| `collected_at` | optional bracket L118 (pipeline-filled) | `NOT NULL` L121 | required L28 (as `article.collected_at \|\| nowIso`), param L98-99 | not set (pipeline: `new Date().toISOString()`) | same | same | OK |
| `content_hash` | optional bracket L119 (pipeline-filled) | `NOT NULL` L123 | required L29, param L101 | not set (pipeline recomputes unconditionally after the `...parsed` spread, `pipeline.js` L216/230 — cannot be overridden by an adapter even if it tried) | same | same | OK |
| `adapter_version` | optional bracket L120 | `NOT NULL` L124 | required L30, param L102 | not set (pipeline fills from `getSourceProfile().adapter_version`) | same | same | OK |
| `parser_version` (not in N5 list, but present at all 4 layers) | optional L121 | `NOT NULL` L125 | param L103, falls back to `adapter_version` if unset | `ADAPTER_VERSION` L91 (identical string to `adapter_version`) | `ADAPTER_VERSION` L89 | `ADAPTER_VERSION` L118 | note — see below, not a gap |
| `validation_status`/`validation_warnings` (system) | explicitly excluded L90-94 | `NOT NULL`/nullable L126-127 | store-owned, L46-52/104-105 | not set (correct) | not set | not set | OK |
| `first_discovered_at`/`last_seen_at` (system) | explicitly excluded L90-94 | `NOT NULL` L120/122 | store-owned, derived from `collected_at`/wall clock L98-100 | not set (correct) | not set | not set | OK |

## P0 must-fix (blocks consistency)

1 item.

- **`canonical_url` is mis-marked optional in the typedef, but it is a hard-required field
  everywhere else in the contract.** `src/core/types.js` L102 writes
  `@property {string} [canonical_url]` — bracket notation, same style used for `source_id`,
  `collected_at`, `content_hash`, `adapter_version` (all L98/118-120). But those four all have
  a **safe pipeline-computed fallback** if an adapter's `parse()`/bridge omits them
  (`pipeline.js` L221-231: `source_id`/`adapter_version` come from `getSourceProfile()`,
  `collected_at` from wall clock, `content_hash` is *recomputed unconditionally* after the
  `...parsed` spread so an adapter literally cannot break it). `canonical_url`'s pipeline
  default is `canonical_url: null` (`pipeline.js` L227) — there is **no safe fallback**. If a
  bridge's `toParsedArticle()` fails to derive it (e.g. `draft.url` is falsy), the spread
  overwrites `null` with `undefined`, and `src/db/articles.js`'s `REQUIRED_ARTICLE_FIELDS`
  (L20-31, includes `canonical_url`) plus the DB's `NOT NULL` constraint (`001_init.sql` L108)
  will reject the article at `assertStorable()` (L33-38), which is caught by
  `pipeline.js`'s store try/catch (L247-271) and silently routed to `DEAD_LETTER` rather than
  surfaced as a contract violation.
  **Recommendation for S2-B:** remove the brackets around `canonical_url` in the typedef (make
  it non-optional, grouped with `title`/`content_text`), and add a one-line comment
  distinguishing "pipeline-guaranteed regardless of adapter output" (`source_id`,
  `adapter_version`, `collected_at`, `content_hash`) from "adapter/bridge MUST supply, no
  fallback" (`canonical_url`, `title`, `content_text`, `requested_url`, `final_url`,
  `normalized_url`). This is a doc-only fix (no behavior change) but it's the one place the
  contract's own source of truth actively misleads a reader about required-ness.

## P1 nice-to-have

3 items.

- **`field_provenance` is inconsistently populated across bridges.** `suara/coreAdapter.js`
  (L62-70/90) and `viva/coreAdapter.js` (`buildFieldProvenance()`, L73-93) both populate rich
  per-field provenance; `detik/coreAdapter.js`'s `toParsedArticle()` (L68-93) never sets
  `field_provenance` at all — not even an empty object. Column is nullable so nothing breaks,
  but it means detik articles have zero extraction-confidence metadata while its two siblings
  do. Recommend detik bridge add at minimum a `published_at`/`canonical_url` provenance entry
  to match the pattern, or a comment explaining why it's deferred.
- **`tags` has no extraction path at all for VIVA.** Confirmed by grep: `src/adapters/viva/index.js`
  has zero references to `tags`/`article-tags`/`detail__body-tag` — the raw adapter never
  extracts tags, so `viva/coreAdapter.js`'s `toParsedArticle()` (L100-121) has no `tags` key at
  all (not even `undefined`), unlike `detik` (`.detail__body-tag a` text[], `detik/index.js`
  L376/397) and `suara` (`.article-tags a` text[] with leading `#` stripped, `suara/index.js`
  L488/527), which both consistently produce `string[]`. Every VIVA article will have
  `tags = null` in DB. Not a bridge bug (nothing to bridge — the raw parser never looked for a
  tags element on VIVA's article template), but worth a tracked follow-up so it isn't mistaken
  for an oversight later.
- **`canonical_url` derivation robustness differs between adapters.** `viva/index.js`
  (L471-476, `stripPageParam`) explicitly strips a `?page=N` query param from the extracted
  canonical URL before using it, specifically to keep multipage articles collapsed to one
  `(source_id, canonical_url)` row. `detik`/`suara` derive their equivalent `url` field from
  `<link rel="canonical">`/`og:url`/JSON-LD `mainEntityOfPage` (`detik/index.js` comment
  L24-ish "url"; `suara/index.js` L52) but do **not** explicitly strip any page param — they
  rely on the source site's own canonical tag never including one. Works today (suara's own
  multipage support, L25-30, already merges pages 2..N under the page-1 URL), but it's an
  implicit assumption rather than a defended invariant like VIVA's. Recommend adding the same
  defensive strip to detik/suara for consistency, low urgency since no incident observed.

## P2 skip / accept

4 items — already correct by design, no action needed.

- **`language` is hardcoded to `"id"`** in all three bridges (`detik` L90, `suara` L88, `viva`
  L117). This matches the typedef's "best-effort" framing (L117) and each source's own
  documented Indonesian-only scope. Accept as-is; only revisit if a non-Indonesian source is
  onboarded.
- **`subtitle` is unimplemented everywhere** — absent from all three raw adapters' return
  shapes, though typedef (L105) and DB (`subtitle TEXT`, L111) both support it. This is
  consistent *absence* (no adapter contradicts another), not a cross-layer mismatch. Skip
  until a source with a genuine dek/subtitle field is added.
- **`updated_at_source` "low confidence" on VIVA** — `viva/coreAdapter.js`'s header comment
  (L27) and `buildFieldProvenance()` (L85, `confidence: 'low'`) already flag that
  `dateModified` is unreliable on that source and is "never used to override `published_at`."
  Already documented at the correct layer; no further action for Sprint 2.
- **`parser_version` currently duplicates `adapter_version`** — all three bridges set
  `parser_version: ADAPTER_VERSION`, the exact same constant used for `adapter_version` (via
  `getSourceProfile()`). `src/db/articles.js` stores both columns (`NOT NULL`, L103/125) and
  even has a fallback (`article.parser_version || article.adapter_version`) for when a future
  adapter omits it. Functionally harmless duplication today; only becomes meaningful if a
  single `adapter_version` ever needs to track two independently-versioned parsing paths. Not
  part of the N5 field list the audit was scoped to — flagged for awareness only.

## notes

- **camelCase leakage risk: audited, low/mitigated.** All three `toParsedArticle()`
  implementations (`detik` L68-93, `suara` L57-92, `viva` L100-121) build a **brand-new**
  return object with explicit snake_case keys — none of them spread the raw camelCase draft
  (`...draft`) into the result. So a stray `publishedAt`/`thumbnailUrl`/`externalId` from the
  raw `_template`-shaped adapters cannot leak through into the stored `ParsedArticle`. The one
  structural weak point: `src/core/adapterContract.js` (`assertAdapterShape`, L32-43) only
  checks that `discover`/`parse`/`isArticleUrl` are functions — there is **no runtime
  field-level check** anywhere that a `parse()`/bridge return value actually matches the
  `ParsedArticle` shape (e.g. rejecting a stray camelCase key). Today's 3 bridges are
  disciplined about this by convention only; a future bridge author who spreads `...draft`
  by mistake would not be caught until store time (missing required field) or, worse, would
  silently write an extra unused column-less key that's just ignored by `articles.js`'s
  positional param list. Worth a lightweight shape-check helper in a later sprint, not P0/P1
  for this audit since no actual leakage exists today.
- **`tags` shape: consistent where implemented.** Both producing adapters (detik, suara) emit
  a plain `string[]`; the bridges pass it through unchanged; `src/db/articles.js` L93
  (`article.tags ? JSON.stringify(article.tags) : null`) serializes it into the `tags JSONB`
  column, which has a GIN index (`001_init.sql` L140-141) sized for exactly this
  array-of-strings shape. No shape drift between detik and suara. (VIVA's total absence of
  tags is tracked separately under P1, not a shape issue.)
- **`published_at` soft-warning status: confirmed working exactly as documented.**
  `REQUIRED_ARTICLE_FIELDS` (`src/db/articles.js` L20-31) deliberately excludes
  `published_at`, with an inline comment (L15-19) explaining why (wire copy/live blogs lack a
  reliable timestamp). `buildValidationWarnings()` (L41-52) appends a `missing_published_at`
  string to `validation_warnings` instead of failing `assertStorable()`. The typedef (L113-115)
  cross-references this exact mechanism. All three bridges pass `draft.publishedAt` through
  as-is (possibly `undefined`) without trying to fabricate a value. This is the one soft/hard
  distinction in the contract that IS clearly and correctly documented everywhere — contrast
  with `canonical_url` in the P0 item above, which has no such fallback but is still marked
  optional.

---

**P0 count: 1.**

**READY FOR S2-B**
