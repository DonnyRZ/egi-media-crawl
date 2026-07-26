'use strict';

/**
 * Read-only EGI-facing DTO for crawl N5 (`n5.v1`) articles.
 *
 * Maps crawl snake_case `ParsedArticle` / store rows onto alias names that align with
 * editorial EGI `articles` columns for *read convenience only*. Does NOT write to the
 * editorial EGI database. Does NOT rename crawl DB columns.
 *
 * See docs/EGI_READ_DTO.md and docs/N5_CONTRACT_LOCKED.md.
 */

/**
 * @typedef {Object} EgiArticleRead
 * @property {string} [title]
 * @property {string} [summary]
 * @property {string} [content] - From crawl `content_text`
 * @property {string} [featured_image] - From crawl `thumbnail_url`
 * @property {string} [published_at]
 * @property {string} [author_name] - Display name string; NOT editorial `author_id` UUID
 * @property {string} [source_url] - Prefer `canonical_url`, else `normalized_url`
 * @property {string} [category]
 * @property {string[]} [tags]
 * @property {string} [language]
 * @property {string} [source_id]
 * @property {string} [external_article_id]
 * @property {string} [content_hash]
 * @property {string} [collected_at]
 * @property {string} [adapter_version]
 * @property {Object} [field_provenance]
 * @property {string} [content_html]
 * @property {string} [subtitle]
 * @property {string} [updated_at_source]
 * @property {string} [requested_url]
 * @property {string} [final_url]
 * @property {string} [normalized_url]
 * @property {string} [canonical_url]
 */

/**
 * Pure mapper: crawl N5 article → EGI-facing read DTO.
 *
 * Always exposes `content` and `featured_image` keys (may be `undefined` when the
 * crawl source fields are absent) so consumers can rely on stable alias names.
 *
 * @param {import('../core/types').ParsedArticle|Object|null|undefined} article
 * @returns {EgiArticleRead}
 */
function toEgiArticleRead(article) {
  const a = article && typeof article === 'object' ? article : {};

  const sourceUrl =
    (typeof a.canonical_url === 'string' && a.canonical_url) ||
    (typeof a.normalized_url === 'string' && a.normalized_url) ||
    undefined;

  /** @type {EgiArticleRead} */
  const dto = {
    title: a.title,
    summary: a.summary,
    content: a.content_text,
    featured_image: a.thumbnail_url,
    published_at: a.published_at,
    author_name: a.author_name,
    source_url: sourceUrl,
    category: a.category,
    tags: a.tags,
    language: a.language,
    source_id: a.source_id,
    external_article_id: a.external_article_id,
    content_hash: a.content_hash,
    collected_at: a.collected_at,
    adapter_version: a.adapter_version,
    field_provenance: a.field_provenance,
    content_html: a.content_html,
    subtitle: a.subtitle,
    updated_at_source: a.updated_at_source,
    requested_url: a.requested_url,
    final_url: a.final_url,
    normalized_url: a.normalized_url,
    canonical_url: a.canonical_url,
  };

  return dto;
}

module.exports = {
  toEgiArticleRead,
};
