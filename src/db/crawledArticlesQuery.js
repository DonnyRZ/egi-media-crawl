'use strict';

const { query } = require('./index');

/**
 * Read-only listing queries for the crawl API.
 * Never writes. Filters by source_id and ILIKE title search.
 */

const LIST_COLUMNS = `
  article_id,
  source_id,
  external_article_id,
  requested_url,
  final_url,
  canonical_url,
  normalized_url,
  title,
  subtitle,
  content_text,
  content_html,
  summary,
  author_name,
  category,
  tags,
  thumbnail_url,
  published_at,
  updated_at_source,
  language,
  collected_at,
  last_seen_at,
  content_hash,
  adapter_version,
  field_provenance
`;

/**
 * @param {object} opts
 * @param {number} opts.page - 1-based
 * @param {number} opts.limit
 * @param {string|null} [opts.sourceId] - exact crawl source_id (e.g. "detik")
 * @param {string|null} [opts.search] - title substring
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function listCrawledArticles({ page, limit, sourceId = null, search = null }) {
  const where = [];
  const params = [];

  if (sourceId) {
    params.push(sourceId);
    where.push(`source_id = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    where.push(`title ILIKE $${params.length}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM articles ${whereSql}`,
    params
  );
  const total = countResult.rows[0]?.total ?? 0;

  const offset = (page - 1) * limit;
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const listResult = await query(
    `
    SELECT ${LIST_COLUMNS}
    FROM articles
    ${whereSql}
    ORDER BY COALESCE(published_at, collected_at) DESC, article_id DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `,
    params
  );

  return { rows: listResult.rows, total };
}

/**
 * Resolve a user-facing source filter ("Detik", "detik", "CNN Indonesia") to a
 * registered source_id, or null when the filter means "all sources".
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function resolveSourceIdFilter(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'all' || trimmed.toLowerCase() === 'egi media') {
    return null;
  }

  const slug = trimmed
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

  const aliases = {
    detik: 'detik',
    detikcom: 'detik',
    viva: 'viva',
    cnn: 'cnn_indonesia',
    cnn_indonesia: 'cnn_indonesia',
    cnnindonesia: 'cnn_indonesia',
    liputan6: 'liputan6',
    liputan_6: 'liputan6',
    suara: 'suara',
    tempo: 'tempo',
    kumparan: 'kumparan',
    tirto: 'tirto',
    jawa_pos: 'jawa_pos',
    jawapos: 'jawa_pos',
    okezone: 'okezone',
    sindonews: 'sindonews',
    idn_times: 'idn_times',
    idntimes: 'idn_times',
    republika: 'republika',
    media_indonesia: 'media_indonesia',
    mediaindonesia: 'media_indonesia',
    merdeka: 'merdeka',
    beritasatu: 'beritasatu',
    tribunnews: 'tribunnews',
  };

  return aliases[slug] || slug;
}

module.exports = {
  listCrawledArticles,
  resolveSourceIdFilter,
};
