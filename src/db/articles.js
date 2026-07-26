'use strict';

const { withTransaction, query } = require('./index');
const { PROCESSING_STATUS } = require('../core/status');

/**
 * Persistence for `articles` / `article_revisions` / `processing_status`
 * (db/migrations/001_init.sql §19.4-19.6).
 *
 * Callers pass the `ParsedArticle` shape produced by `runPipeline` (src/core/pipeline.js) —
 * i.e. after core has already filled in `requested_url`/`final_url`/`normalized_url`/
 * `collected_at`/`content_hash` and merged the adapter's `parse()` output over them.
 */

// Store required gate (N5 normalized-field-contract): every article MUST carry these
// fields to be persisted at all. `published_at` is deliberately NOT in this list — some
// sources (wire copy, live blogs) don't reliably expose a publish timestamp, so a missing
// `published_at` is soft/warning-only: `upsertArticle` appends a `missing_published_at`
// entry to `validation_warnings` instead of rejecting the article (see below).
const REQUIRED_ARTICLE_FIELDS = [
  'source_id',
  'requested_url',
  'final_url',
  'canonical_url',
  'normalized_url',
  'title',
  'content_text',
  'content_hash',
  'collected_at',
  'adapter_version',
];

function assertStorable(article) {
  const missing = REQUIRED_ARTICLE_FIELDS.filter((field) => !article || !article[field]);
  if (missing.length > 0) {
    throw new TypeError(`upsertArticle: article is missing required field(s): ${missing.join(', ')}`);
  }
}

/**
 * Build the `validation_warnings` array to persist, appending a soft warning for a missing
 * `published_at` without failing the store gate (see REQUIRED_ARTICLE_FIELDS comment above).
 * @param {import('../core/types').ParsedArticle} article
 * @returns {string[]}
 */
function buildValidationWarnings(article) {
  const warnings = Array.isArray(article.validation_warnings) ? [...article.validation_warnings] : [];
  if (!article.published_at && !warnings.includes('missing_published_at')) {
    warnings.push('missing_published_at');
  }
  return warnings;
}

/**
 * Upsert one article by `(source_id, canonical_url)` (the table's UNIQUE constraint).
 * Inserts a new row on first sight; on a later run for the same canonical URL, updates
 * the "latest known state" columns in place and inserts an `article_revisions` row only
 * when `content_hash` actually changed (or on first insert) — `article_revisions` is a
 * history log, not a 1:1 mirror of every crawl pass.
 *
 * `first_discovered_at` is intentionally left out of the `ON CONFLICT ... DO UPDATE SET`
 * list below so re-crawls never overwrite the original discovery time.
 *
 * @param {import('../core/types').ParsedArticle} article
 * @returns {Promise<{articleId: string, isNew: boolean, contentChanged: boolean}>}
 */
async function upsertArticle(article) {
  assertStorable(article);

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      'SELECT article_id, content_hash FROM articles WHERE source_id = $1 AND canonical_url = $2',
      [article.source_id, article.canonical_url]
    );
    const previous = existingRows[0];
    const nowIso = new Date().toISOString();
    const validationWarnings = buildValidationWarnings(article);

    const params = [
      article.source_id,
      article.external_article_id || null,
      article.requested_url,
      article.final_url,
      article.canonical_url,
      article.normalized_url,
      article.title,
      article.subtitle || null,
      article.content_text,
      article.content_html || null,
      article.summary || null,
      article.author_name || null,
      article.category || null,
      article.tags ? JSON.stringify(article.tags) : null,
      article.thumbnail_url || null,
      article.published_at || null,
      article.updated_at_source || null,
      article.language || null,
      article.collected_at || nowIso, // first_discovered_at (insert-only, see ON CONFLICT below)
      article.collected_at || nowIso,
      nowIso, // last_seen_at
      article.content_hash,
      article.adapter_version,
      article.parser_version || article.adapter_version,
      article.validation_status || 'valid',
      validationWarnings.length > 0 ? JSON.stringify(validationWarnings) : null,
      article.field_provenance ? JSON.stringify(article.field_provenance) : null,
    ];

    const { rows } = await client.query(
      `
      INSERT INTO articles (
        source_id, external_article_id, requested_url, final_url, canonical_url, normalized_url,
        title, subtitle, content_text, content_html, summary, author_name, category, tags, thumbnail_url,
        published_at, updated_at_source, language, first_discovered_at, collected_at, last_seen_at,
        content_hash, adapter_version, parser_version, validation_status, validation_warnings, field_provenance
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
      )
      ON CONFLICT (source_id, canonical_url) DO UPDATE SET
        external_article_id = EXCLUDED.external_article_id,
        requested_url         = EXCLUDED.requested_url,
        final_url              = EXCLUDED.final_url,
        normalized_url         = EXCLUDED.normalized_url,
        title                   = EXCLUDED.title,
        subtitle                = EXCLUDED.subtitle,
        content_text            = EXCLUDED.content_text,
        content_html            = EXCLUDED.content_html,
        summary                  = EXCLUDED.summary,
        author_name             = EXCLUDED.author_name,
        category                 = EXCLUDED.category,
        tags                     = EXCLUDED.tags,
        thumbnail_url            = EXCLUDED.thumbnail_url,
        published_at             = EXCLUDED.published_at,
        updated_at_source        = EXCLUDED.updated_at_source,
        language                  = EXCLUDED.language,
        collected_at             = EXCLUDED.collected_at,
        last_seen_at             = EXCLUDED.last_seen_at,
        content_hash             = EXCLUDED.content_hash,
        adapter_version          = EXCLUDED.adapter_version,
        parser_version           = EXCLUDED.parser_version,
        validation_status        = EXCLUDED.validation_status,
        validation_warnings      = EXCLUDED.validation_warnings,
        field_provenance         = EXCLUDED.field_provenance
      RETURNING article_id
      `,
      params
    );

    const articleId = rows[0].article_id;
    const isNew = !previous;
    const contentChanged = !isNew && previous.content_hash !== article.content_hash;

    if (isNew || contentChanged) {
      await client.query(
        `
        INSERT INTO article_revisions (article_id, content_hash, title, content_text, captured_at, parser_version)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          articleId,
          article.content_hash,
          article.title,
          article.content_text,
          nowIso,
          article.parser_version || article.adapter_version || 'unknown',
        ]
      );
    }

    return { articleId, isNew, contentChanged };
  });
}

/**
 * Upsert the current `processing_status` row for a `(source_id, normalized_url)` pair
 * (db/migrations/001_init.sql §19.6). `attempts` increments on every call so repeated
 * crawl passes over the same URL are visible in the audit trail.
 *
 * @param {{sourceId: string, normalizedUrl: string, status: string, reason?: string, articleId?: string}} params
 * @returns {Promise<{status_id: string}>}
 */
async function upsertProcessingStatus({ sourceId, normalizedUrl, status, reason, articleId }) {
  if (!sourceId) throw new TypeError('upsertProcessingStatus: sourceId is required');
  if (!normalizedUrl) throw new TypeError('upsertProcessingStatus: normalizedUrl is required');
  if (!status) throw new TypeError('upsertProcessingStatus: status is required');

  const { rows } = await query(
    `
    INSERT INTO processing_status (source_id, normalized_url, status, reason, article_id, attempts)
    VALUES ($1, $2, $3, $4, $5, 1)
    ON CONFLICT (source_id, normalized_url) DO UPDATE SET
      status      = EXCLUDED.status,
      reason       = EXCLUDED.reason,
      article_id    = COALESCE(EXCLUDED.article_id, processing_status.article_id),
      attempts       = processing_status.attempts + 1
    RETURNING status_id
    `,
    [sourceId, normalizedUrl, status, reason || null, articleId || null]
  );

  return rows[0];
}

/**
 * `runPipeline`-compatible `storeFn` (see src/core/pipeline.js `RunPipelineParams.storeFn`):
 * persists the article, writes a revision if content changed, and updates
 * `processing_status` to a terminal `stored`/`duplicate` state. Resolving with
 * `{status, reason}` lets the pipeline report `PROCESSING_STATUS.DUPLICATE` instead of
 * its default `STORED` when the content hash didn't actually change.
 *
 * @param {import('../core/types').ParsedArticle} article
 * @returns {Promise<{status: string, reason: string, articleId: string}>}
 */
async function storeParsedArticle(article) {
  const { articleId, isNew, contentChanged } = await upsertArticle(article);

  const status = isNew || contentChanged ? PROCESSING_STATUS.STORED : PROCESSING_STATUS.DUPLICATE;
  const reason = isNew ? 'new_article' : contentChanged ? 'content_updated' : 'duplicate_content';

  await upsertProcessingStatus({
    sourceId: article.source_id,
    normalizedUrl: article.normalized_url,
    status,
    reason,
    articleId,
  });

  return { status, reason, articleId };
}

module.exports = {
  upsertArticle,
  upsertProcessingStatus,
  storeParsedArticle,
};
