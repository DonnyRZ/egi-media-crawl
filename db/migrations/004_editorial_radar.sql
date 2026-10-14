-- Additive candidate storage. Legacy event_runs/news_events remain intact.
CREATE TABLE radar_cohorts (
  version TEXT PRIMARY KEY, sources JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE radar_observations (
  observation_id BIGSERIAL PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
  normalized_url TEXT NOT NULL, title TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel TEXT NOT NULL, category TEXT, provenance TEXT NOT NULL DEFAULT 'official_listing',
  UNIQUE(source_id, normalized_url)
);
CREATE INDEX radar_observations_published ON radar_observations(published_at, observation_id);
CREATE TABLE radar_source_health (
  source_id TEXT NOT NULL REFERENCES sources(source_id), channel TEXT NOT NULL,
  last_attempt_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ, state TEXT NOT NULL,
  reason TEXT, discovered_count INTEGER NOT NULL DEFAULT 0, complete BOOLEAN NOT NULL DEFAULT FALSE,
  watermark_at TIMESTAMPTZ, cursor JSONB NOT NULL DEFAULT '{}', PRIMARY KEY(source_id, channel)
);
CREATE TABLE radar_runs (
  run_id BIGSERIAL PRIMARY KEY, window_hours INTEGER NOT NULL, cohort_version TEXT NOT NULL REFERENCES radar_cohorts(version),
  algorithm_version TEXT NOT NULL, as_of TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at TIMESTAMPTZ, status TEXT NOT NULL, eligible_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0,
  health JSONB NOT NULL DEFAULT '[]', error_message TEXT
);
CREATE TABLE radar_source_checks (
  check_id BIGSERIAL PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
  channel TEXT NOT NULL, attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  state TEXT NOT NULL, complete BOOLEAN NOT NULL, reason TEXT
);
CREATE INDEX radar_source_checks_time ON radar_source_checks(source_id,channel,attempted_at DESC);
CREATE INDEX radar_runs_latest ON radar_runs(window_hours, finished_at DESC) WHERE status='succeeded';
CREATE TABLE radar_events (
  event_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE radar_snapshots (
  run_id BIGINT NOT NULL REFERENCES radar_runs(run_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES radar_events(event_id), title TEXT NOT NULL, category TEXT,
  score NUMERIC NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(run_id,event_id)
);
CREATE INDEX radar_snapshots_rank ON radar_snapshots(run_id, score DESC, event_id);
CREATE TABLE radar_members (
  event_id TEXT NOT NULL REFERENCES radar_events(event_id), observation_key TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX radar_members_event ON radar_members(event_id);
CREATE TABLE radar_run_members (
  run_id BIGINT NOT NULL REFERENCES radar_runs(run_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, observation_key TEXT NOT NULL, payload JSONB NOT NULL,
  PRIMARY KEY(run_id, observation_key)
);
CREATE INDEX radar_run_members_event ON radar_run_members(run_id,event_id);
CREATE INDEX radar_articles_time ON articles((COALESCE(published_at,first_discovered_at)), article_id)
  WHERE validation_status='valid';
