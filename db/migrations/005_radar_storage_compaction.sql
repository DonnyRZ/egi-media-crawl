-- Keep the per-run membership history needed by the current CMS, but avoid
-- repeating a JSON document for every article on every Radar refresh.
ALTER TABLE radar_run_members ALTER COLUMN payload DROP NOT NULL;
ALTER TABLE radar_run_members
  ADD COLUMN source_id TEXT,
  ADD COLUMN source_label TEXT,
  ADD COLUMN title TEXT,
  ADD COLUMN published_at TIMESTAMPTZ,
  ADD COLUMN evidence_quality TEXT,
  ADD COLUMN angle_id TEXT,
  ADD COLUMN match_score REAL;

COMMENT ON COLUMN radar_run_members.payload IS
  'Legacy JSON payload; new rows use compact scalar columns and leave this NULL.';

-- New writes use these compact fields; legacy rows remain readable until normal
-- retention removes them. Existing Crawl articles/observations are untouched.
