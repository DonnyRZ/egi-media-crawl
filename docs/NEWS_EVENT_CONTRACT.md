# News Event Contract (lexical-v1)

Status: S15 design contract

## Purpose

`news_event` is a derived cross-media coverage record. It represents one concrete
news event that is reported by at least two distinct registered sources inside a
selected time window. It is not a replacement for `articles`, and it does not
change or delete source article data.

The primary time axis is `articles.collected_at`, because it measures when EGI
Media received the article. `published_at` is retained as article metadata and is
used for display/diagnostics, not for run cutoffs.

## Event identity

The lexical-v1 engine assigns articles to a stable representative event using
deterministic lexical anchors. Anchors can include distinctive names, entities,
places, actions, numbers, dates, and multi-word phrases. Generic words such as
`polisi`, `pemerintah`, and `berita` cannot create an event by themselves.

The engine uses candidate blocking and representative-based assignment. It does
not use embeddings, vector databases, LLM calls, or unrestricted connected
components. A new article must match the event representative strongly enough to
join; a weak transitive link cannot pull an unrelated article into the event.

## Derived fields

| Field | Meaning |
|---|---|
| `event_id` | Database identity of a derived event within an event run |
| `run_id` | The aggregation execution that produced the event |
| `representative_title` | The most central source title selected for display |
| `anchor_terms` | JSON array of distinctive terms supporting the event identity |
| `article_count` | Number of distinct source articles assigned to the event |
| `media_count` | Number of distinct `source_id` values assigned to the event |
| `coverage_score` | Deterministic coverage score based on media breadth and article volume |
| `first_seen_at` | Earliest `collected_at` among member articles |
| `last_seen_at` | Latest `collected_at` among member articles |
| `algorithm_version` | Algorithm identifier, currently `lexical-v1` |
| `match_score` | Article-to-event assignment score |
| `match_reason` | Small JSON diagnostic, never full article content |

Only events with at least two distinct media are persisted as cross-media events.
The UI-facing term should be “event” or “cross-media coverage”; the word
“viral” is not part of this data contract.

## Windows and reproducibility

The supported windows are 24, 72, and 168 hours. A run records its exact cutoff,
anchor time, window, configuration, and algorithm version. Rerunning the same
`run_key` is idempotent: the existing derived snapshot is replaced atomically,
while the immutable `articles` table is never updated by event aggregation.

## Resource and safety rules

- The engine reads only `title`, `summary`, `source_id`, `collected_at`, and
  `published_at` from the article table.
- `content_text`, `content_html`, thumbnails, and article revisions are not loaded.
- Aggregation runs in a separate queue/job and must not block crawl discovery,
  fetch, or parse workers.
- Derived writes are limited to `event_runs`, `news_events`, and
  `news_event_articles` in the dedicated `egi_crawl` database.
