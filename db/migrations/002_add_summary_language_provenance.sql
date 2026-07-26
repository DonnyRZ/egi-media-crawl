-- 002_add_summary_language_provenance.sql
-- Adds the N5-normalized-field-contract columns to `articles` ahead of the
-- live source adapters (P1-P3): a short human/machine-generated summary, a
-- best-effort content language code, and an optional per-field provenance
-- map (e.g. { "published_at": { "source": "json_ld", "confidence": "high" } }).
--
-- All three columns are nullable — existing rows and adapters that don't
-- populate them yet keep working unchanged. Do not edit 001_init.sql; this
-- file is applied on top of it by scripts/migrate.js (`npm run migrate`).

ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS summary TEXT,
    ADD COLUMN IF NOT EXISTS language TEXT,
    ADD COLUMN IF NOT EXISTS field_provenance JSONB;
