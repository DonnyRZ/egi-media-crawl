# Sprint 10 QA — Freeze N5 contract + EGI-facing read DTO

**Verdict: GO**

**Scope:** Lock the crawl N5 field contract as `n5.v1` (docs + SoT header comments) and ship a
**read-only** EGI-facing DTO mapper (`toEgiArticleRead`) so AI/consumers can use stable alias
names (`content`, `featured_image`, …) without renaming crawl storage or writing to the
editorial EGI database.

**Out of scope / hard bans confirmed:**

- No INSERT/UPDATE to editorial `egi-media-backend` `articles`
- No crawl DB column renames / migrations
- No adapter / registry / scheduler changes
- Store gate in `src/db/articles.js` unchanged (not weakened)

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Locked contract doc exists with status LOCKED, date 2026-07-24, version `n5.v1` | ✅ PASS | `docs/N5_CONTRACT_LOCKED.md` — required / soft-required / optional / pipeline-owned tables, snake_case rule, semantics, change policy, SoT pointers |
| 2 | Code SoT mirrors tagged LOCKED without field-list changes | ✅ PASS | Header comment `// N5 LOCKED n5.v1 — see docs/N5_CONTRACT_LOCKED.md` on `src/core/fieldContract.js` and `src/core/types.js`; `REQUIRED`/`SOFT`/`OPTIONAL` lists and `articles.js` `assertStorable` unchanged |
| 3 | DTO maps crawl → EGI aliases correctly | ✅ PASS | `src/dto/egiArticleRead.js`: `content_text`→`content`, `thumbnail_url`→`featured_image`, `canonical_url`/`normalized_url`→`source_url`, plus identity/passthrough fields; JSDoc `EgiArticleRead` typedef; documented in `docs/EGI_READ_DTO.md` |
| 4 | No editorial DB writes; crawl columns unchanged | ✅ PASS | Mapper is pure (no DB imports); adapters/migrations/`articles.js` store path untouched |
| 5 | Smoke asserts alias keys and mapping; exit 0 | ✅ PASS | `npm run smoke:egi-read-dto` → `[egiArticleRead smoke] PASS`, exit `0` |
| 6 | Done criteria met | ✅ PASS | Stable N5 docs locked; read-only DTO aliases available; crawl stays snake_case; no editorial writes |

## GO criteria re-check

- **N5 contract frozen as `n5.v1`** — yes (`docs/N5_CONTRACT_LOCKED.md` + SoT headers).
- **EGI-facing read DTO with documented mapping + example** — yes (`src/dto/egiArticleRead.js`, `docs/EGI_READ_DTO.md`).
- **Smoke PASS** — yes (`npm run smoke:egi-read-dto` / `node src/dto/egiArticleRead.smoke.js`).
- **No out-of-scope / banned changes** — yes (checklist 2, 4).

## How I verified

```bash
npm run smoke:egi-read-dto
# equivalent: node src/dto/egiArticleRead.smoke.js
```

Output:

```
[egiArticleRead smoke] PASS
{
  "content": "Plain body text",
  "featured_image": "https://cdn.example/image.jpg",
  "source_url": "https://news.detik.com/berita/d-1/canonical"
}
```

Diff scope for this sprint:

- `docs/N5_CONTRACT_LOCKED.md` (new)
- `docs/EGI_READ_DTO.md` (new)
- `docs/SPRINT10_QA.md` (this file)
- `src/dto/egiArticleRead.js` (new)
- `src/dto/egiArticleRead.smoke.js` (new)
- `src/core/fieldContract.js` (LOCKED header comment only)
- `src/core/types.js` (LOCKED header comment only)
- `package.json` (`smoke:egi-read-dto` script)
