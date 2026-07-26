-- 001_init.sql
-- Initial schema for egi-media-crawl.
--
-- Source of truth: Reliable-News-Article-Scraping.md, section 19 "Penyimpanan Data".
-- Separates discovery, fetch-attempt, article, and audit data, plus a
-- `processing_status` table that tracks the current state-machine status of
-- every (source_id, normalized_url) pair (see section 19.6 / 21.4).
--
-- This file is applied by scripts/migrate.js inside a single transaction.
-- Do not edit an already-applied migration file; add a new numbered file
-- instead.

-- ---------------------------------------------------------------------------
-- Helper: generic trigger to keep an `updated_at` column current on UPDATE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 19.1 sources
-- ---------------------------------------------------------------------------
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

CREATE TRIGGER trg_sources_set_updated_at
    BEFORE UPDATE ON sources
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 19.2 discovered_urls
-- Append-style discovery log: one row per (source, normalized url, channel).
-- Re-discovery bumps discovery_count / last_discovered_at instead of
-- inserting a duplicate row (see UNIQUE constraint).
-- ---------------------------------------------------------------------------
CREATE TABLE discovered_urls (
    discovery_id        BIGSERIAL PRIMARY KEY,
    source_id           TEXT NOT NULL REFERENCES sources(source_id),
    raw_url              TEXT NOT NULL,
    normalized_url       TEXT NOT NULL,
    discovery_channel    TEXT NOT NULL,
    discovery_page       TEXT,
    listing_title        TEXT,
    published_hint       TIMESTAMPTZ,
    first_discovered_at  TIMESTAMPTZ NOT NULL,
    last_discovered_at   TIMESTAMPTZ NOT NULL,
    discovery_count      INTEGER NOT NULL DEFAULT 1,
    UNIQUE (source_id, normalized_url, discovery_channel)
);

CREATE INDEX idx_discovered_urls_source_last_seen
    ON discovered_urls (source_id, last_discovered_at DESC);

CREATE INDEX idx_discovered_urls_normalized_url
    ON discovered_urls (normalized_url);

-- ---------------------------------------------------------------------------
-- 19.3 fetch_attempts
-- Append-only audit log of every fetch attempt (success or failure).
-- ---------------------------------------------------------------------------
CREATE TABLE fetch_attempts (
    fetch_id            BIGSERIAL PRIMARY KEY,
    source_id           TEXT NOT NULL REFERENCES sources(source_id),
    normalized_url       TEXT NOT NULL,
    attempted_at         TIMESTAMPTZ NOT NULL,
    attempt_number       INTEGER NOT NULL,
    http_status          INTEGER,
    response_time_ms     INTEGER,
    response_bytes       INTEGER,
    final_url            TEXT,
    error_type           TEXT,
    error_message        TEXT,
    retry_scheduled_at   TIMESTAMPTZ
);

CREATE INDEX idx_fetch_attempts_source_url
    ON fetch_attempts (source_id, normalized_url);

CREATE INDEX idx_fetch_attempts_attempted_at
    ON fetch_attempts (attempted_at DESC);

-- ---------------------------------------------------------------------------
-- 19.4 articles
-- Latest known state of a stored article. Historical bodies live in
-- article_revisions.
-- ---------------------------------------------------------------------------
CREATE TABLE articles (
    article_id              BIGSERIAL PRIMARY KEY,
    source_id                TEXT NOT NULL REFERENCES sources(source_id),
    external_article_id      TEXT,
    requested_url             TEXT NOT NULL,
    final_url                 TEXT NOT NULL,
    canonical_url             TEXT NOT NULL,
    normalized_url            TEXT NOT NULL,
    title                     TEXT NOT NULL,
    subtitle                  TEXT,
    content_text              TEXT NOT NULL,
    content_html              TEXT,
    author_name               TEXT,
    category                  TEXT,
    tags                      JSONB,
    thumbnail_url             TEXT,
    published_at              TIMESTAMPTZ,
    updated_at_source         TIMESTAMPTZ,
    first_discovered_at       TIMESTAMPTZ NOT NULL,
    collected_at              TIMESTAMPTZ NOT NULL,
    last_seen_at              TIMESTAMPTZ NOT NULL,
    content_hash              TEXT NOT NULL,
    adapter_version           TEXT NOT NULL,
    parser_version            TEXT NOT NULL,
    validation_status         TEXT NOT NULL,
    validation_warnings       JSONB,
    UNIQUE (source_id, canonical_url)
);

CREATE INDEX idx_articles_published_at
    ON articles (published_at DESC);

CREATE INDEX idx_articles_normalized_url
    ON articles (normalized_url);

CREATE INDEX idx_articles_content_hash
    ON articles (content_hash);

CREATE INDEX idx_articles_tags_gin
    ON articles USING GIN (tags);

-- ---------------------------------------------------------------------------
-- 19.5 article_revisions
-- One row per captured revision of an article's content, keyed by hash so a
-- source updating an article (correction, live-blog update, etc.) keeps a
-- full history.
-- ---------------------------------------------------------------------------
CREATE TABLE article_revisions (
    revision_id         BIGSERIAL PRIMARY KEY,
    article_id          BIGINT NOT NULL REFERENCES articles(article_id),
    content_hash        TEXT NOT NULL,
    title               TEXT NOT NULL,
    content_text        TEXT NOT NULL,
    captured_at         TIMESTAMPTZ NOT NULL,
    parser_version      TEXT NOT NULL
);

CREATE INDEX idx_article_revisions_article_id
    ON article_revisions (article_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- 19.6 processing_status
-- One row per (source_id, normalized_url): the current position in the
-- discovery -> queued -> fetching -> fetched -> parsed -> stored state
-- machine (or a terminal failure/ignore state). This is what the queue
-- consults to decide what to do next, and what section 21.4's audit query
-- joins against discovered_urls to guarantee no URL is left without a final
-- status.
--
-- discovered_urls / fetch_attempts / article_revisions stay append-only logs;
-- this table is the single mutable "current status" pointer, updated in
-- place as a URL moves through the pipeline.
-- ---------------------------------------------------------------------------
CREATE TABLE processing_status (
    status_id           BIGSERIAL PRIMARY KEY,
    source_id            TEXT NOT NULL REFERENCES sources(source_id),
    normalized_url        TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'discovered'
                              CHECK (status IN (
                                  'discovered',
                                  'queued',
                                  'fetching',
                                  'retry_scheduled',
                                  'fetched',
                                  'parsed',
                                  'valid',
                                  'stored',
                                  'duplicate',
                                  'invalid',
                                  'blocked',
                                  'ignored_by_policy',
                                  'dead_letter'
                              )),
    reason                TEXT,
    attempts              INTEGER NOT NULL DEFAULT 0,
    article_id            BIGINT REFERENCES articles(article_id),
    first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status_updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, normalized_url)
);

CREATE INDEX idx_processing_status_status
    ON processing_status (status);

CREATE INDEX idx_processing_status_source_status
    ON processing_status (source_id, status);

-- processing_status uses `status_updated_at` (not `updated_at`), so it gets
-- its own trigger function rather than reusing set_updated_at().
CREATE OR REPLACE FUNCTION set_status_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.status_updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_processing_status_set_status_updated_at
    BEFORE UPDATE ON processing_status
    FOR EACH ROW
    EXECUTE FUNCTION set_status_updated_at();
