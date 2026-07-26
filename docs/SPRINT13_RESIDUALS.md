# Sprint 13 residuals — S13-A (Overlap parse)

For S13-D quality gate. Local/fixture-first; no schedule/rate-limit/compose changes in this pass.

## Fixed (S13-A)

- Shared helper: `src/core/parseListingDate.js` (`parseListingDate` / `parseListingDateIso`).
- `src/core/overlap.js` `isOlderThanCutoff` uses that parser (Indonesian listing forms + ISO).
- Wired `tryParseHint` → shared parser: **detik**, **suara**, **viva**, **sindonews**.
- Smoke: `npm run smoke:overlap-parse`.

## Residuals still open

1. **Detik live indeks has no per-item timestamp** — `parseListingHtml()` still never sets `publishedHint`. Overlap stop works on the fixture listing (and will work the day indeks dates are scraped) but live detik still degrades to plain `limit`.
2. **Suara live time-only fragments** — today's rows often show `"07:08"` without a day; those stay unparseable on purpose (no invented calendar day). Full Indonesian strings (fixture / older live rows) parse and can stop mid-list.
3. **Other adapters** may still pass relative hints ("N menit lalu") that this parser cannot resolve — same safe non-stop behavior as before.
4. Carry-over from S12 (not this agent): fetch-job idempotency on soak, immediate scheduler iterations on upsert, derived fetch delay floor, compose orphan Redis note.
