'use strict';

const {
  listCrawledArticles,
  resolveSourceIdFilter,
} = require('../../db/crawledArticlesQuery');
const { toEgiArticleRead } = require('../../dto/egiArticleRead');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

/**
 * Parse and clamp pagination query params.
 * @param {unknown} pageRaw
 * @param {unknown} limitRaw
 * @returns {{ page: number, limit: number }}
 */
function parsePagination(pageRaw, limitRaw) {
  const page = Math.max(1, Number.parseInt(String(pageRaw ?? DEFAULT_PAGE), 10) || DEFAULT_PAGE);
  let limit = Number.parseInt(String(limitRaw ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
  limit = Math.min(MAX_LIMIT, Math.max(1, limit));
  return { page, limit };
}

/**
 * GET /api/crawled-articles
 * Query: page, limit, source (source_id or display alias), search (title)
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getCrawledArticles(req, res) {
  try {
    const { page, limit } = parsePagination(req.query.page, req.query.limit);
    const sourceId = resolveSourceIdFilter(
      typeof req.query.source === 'string' ? req.query.source : null
    );
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : null;

    const { rows, total } = await listCrawledArticles({
      page,
      limit,
      sourceId,
      search,
    });

    const items = rows.map((row) => {
      const dto = toEgiArticleRead(row);
      return {
        article_id: String(row.article_id),
        ...dto,
        published_at: row.published_at
          ? new Date(row.published_at).toISOString()
          : undefined,
        collected_at: row.collected_at
          ? new Date(row.collected_at).toISOString()
          : undefined,
        updated_at_source: row.updated_at_source
          ? new Date(row.updated_at_source).toISOString()
          : undefined,
      };
    });

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      data: {
        items,
        page,
        limit,
        total,
        total_pages: totalPages,
        source: sourceId,
        search,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list crawled articles';
    console.error(JSON.stringify({ event: 'crawled_articles_error', message, ts: new Date().toISOString() }));
    return res.status(500).json({
      success: false,
      error: { message: 'Internal server error' },
    });
  }
}

/**
 * GET /api/health — liveness for local/ops checks.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
function getHealth(_req, res) {
  res.status(200).json({ success: true, data: { status: 'ok', service: 'egi-media-crawl-api' } });
}

module.exports = {
  getCrawledArticles,
  getHealth,
  parsePagination,
};
