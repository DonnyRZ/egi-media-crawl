'use strict';

// N5 LOCKED n5.v1 — see docs/N5_CONTRACT_LOCKED.md

/**
 * N5 normalized-field-contract: single source-of-truth lists for which `ParsedArticle`
 * (src/core/types.js) fields are required vs optional. Mirrors (and does not replace)
 * `src/db/articles.js`'s `REQUIRED_ARTICLE_FIELDS`/`assertStorable()`, which remains the
 * actual store-time enforcement gate — this module exists so core/adapter code and tests can
 * reference the contract without importing the db layer.
 */

// Every ParsedArticle MUST have these before it reaches the store layer. Of these,
// source_id/adapter_version/collected_at/content_hash are pipeline-guaranteed (runPipeline
// fills them in regardless of adapter output, see pipeline.js); the rest must come from the
// adapter's parse()/bridge — canonical_url additionally gets a defensive pipeline fallback
// (normalized_url/final_url) as of Sprint 2, but adapters should still supply it directly.
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

// Soft-required: absence doesn't fail the store gate, but `src/db/articles.js`'s
// `buildValidationWarnings()` records a `missing_published_at`-style warning instead.
const SOFT_REQUIRED_ARTICLE_FIELDS = ['published_at'];

// Fully optional N5 fields: may be omitted entirely with no warning or fallback.
const N5_OPTIONAL_FIELDS = [
  'external_article_id',
  'subtitle',
  'content_html',
  'summary',
  'author_name',
  'category',
  'tags',
  'thumbnail_url',
  'updated_at_source',
  'language',
  'parser_version',
  'field_provenance',
];

module.exports = {
  REQUIRED_ARTICLE_FIELDS,
  SOFT_REQUIRED_ARTICLE_FIELDS,
  N5_OPTIONAL_FIELDS,
};
