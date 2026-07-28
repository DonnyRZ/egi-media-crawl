-- S15: derived cross-media news event snapshots.
-- Never alter the immutable articles/article_revisions contract here.

CREATE TABLE event_runs (
    run_id              BIGSERIAL PRIMARY KEY,
    run_key             TEXT NOT NULL UNIQUE,
    window_hours        INTEGER NOT NULL CHECK (window_hours IN (24, 72, 168)),
    algorithm_version   TEXT NOT NULL,
    anchor_at           TIMESTAMPTZ NOT NULL,
    cutoff_at           TIMESTAMPTZ NOT NULL,
    status              TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'succeeded', 'failed', 'dry_run')),
    article_count       INTEGER NOT NULL DEFAULT 0,
    candidate_count     INTEGER NOT NULL DEFAULT 0,
    event_count         INTEGER NOT NULL DEFAULT 0,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,
    error_message       TEXT,
    config              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_event_runs_window_started
    ON event_runs (window_hours, started_at DESC);

CREATE TABLE news_events (
    event_id             BIGSERIAL PRIMARY KEY,
    run_id               BIGINT NOT NULL REFERENCES event_runs(run_id) ON DELETE CASCADE,
    representative_title TEXT NOT NULL,
    anchor_terms         JSONB NOT NULL DEFAULT '[]'::jsonb,
    article_count        INTEGER NOT NULL CHECK (article_count >= 2),
    media_count          INTEGER NOT NULL CHECK (media_count >= 2),
    coverage_score       NUMERIC(10, 4) NOT NULL DEFAULT 0,
    first_seen_at        TIMESTAMPTZ NOT NULL,
    last_seen_at         TIMESTAMPTZ NOT NULL,
    algorithm_version    TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, event_id)
);

CREATE INDEX idx_news_events_run_coverage
    ON news_events (run_id, media_count DESC, article_count DESC);

CREATE TABLE news_event_articles (
    run_id          BIGINT NOT NULL REFERENCES event_runs(run_id) ON DELETE CASCADE,
    event_id        BIGINT NOT NULL REFERENCES news_events(event_id) ON DELETE CASCADE,
    article_id      BIGINT NOT NULL REFERENCES articles(article_id),
    source_id       TEXT NOT NULL REFERENCES sources(source_id),
    match_score     NUMERIC(10, 6) NOT NULL DEFAULT 0,
    match_reason    JSONB NOT NULL DEFAULT '{}'::jsonb,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, event_id, article_id),
    UNIQUE (run_id, article_id)
);

CREATE INDEX idx_news_event_articles_article
    ON news_event_articles (article_id);

CREATE INDEX idx_news_event_articles_source
    ON news_event_articles (run_id, source_id);
