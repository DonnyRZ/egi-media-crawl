'use strict';

require('dotenv').config();

const http = require('node:http');
const { URL } = require('node:url');
const pool = require('../db/pool');

const DEFAULT_PORT = 5050;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const WINDOWS = new Set([24, 72, 168]);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': process.env.API_CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
  });
  res.end(payload);
}

function parseWindow(value) {
  const windowHours = value === null || value === '' ? 72 : Number(value);
  if (!Number.isInteger(windowHours) || !WINDOWS.has(windowHours)) {
    const error = new Error('window_hours must be one of 24, 72, or 168');
    error.status = 400;
    throw error;
  }
  return windowHours;
}

function parseLimit(value) {
  const limit = value === null || value === '' ? DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    const error = new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    error.status = 400;
    throw error;
  }
  return limit;
}

function parsePage(value) {
  const page = value === null || value === '' ? 1 : Number(value);
  if (!Number.isInteger(page) || page < 1) {
    const error = new Error('page must be a positive integer');
    error.status = 400;
    throw error;
  }
  return page;
}

async function readIssues(windowHours, limit, db = pool) {
  const runResult = await db.query(
    `SELECT run_id, window_hours, algorithm_version, anchor_at, cutoff_at,
            article_count, event_count, finished_at
       FROM event_runs
      WHERE status = 'succeeded' AND window_hours = $1
      ORDER BY finished_at DESC NULLS LAST, run_id DESC
      LIMIT 1`,
    [windowHours],
  );
  const run = runResult.rows[0];
  if (!run) {
    return {
      items: [],
      meta: {
        windowHours,
        availability: 'warming_up',
        algorithmVersion: 'lexical-v1',
      },
    };
  }

  const result = await db.query(
    `SELECT ne.event_id, ne.representative_title, ne.article_count,
            ne.media_count, ne.first_seen_at, ne.last_seen_at,
            nea.article_id, nea.match_score,
            a.title, a.canonical_url, a.normalized_url, a.thumbnail_url,
            a.published_at, a.collected_at, s.source_id, s.display_name
       FROM news_events ne
       JOIN news_event_articles nea
         ON nea.run_id = ne.run_id AND nea.event_id = ne.event_id
       JOIN articles a ON a.article_id = nea.article_id
       JOIN sources s ON s.source_id = nea.source_id
      WHERE ne.run_id = $1
      ORDER BY ne.media_count DESC, ne.article_count DESC,
               ne.event_id ASC, COALESCE(a.published_at, a.collected_at) DESC`,
    [run.run_id],
  );
  const byEvent = new Map();
  for (const row of result.rows) {
    let issue = byEvent.get(row.event_id);
    if (!issue) {
      issue = {
        id: `event-${row.event_id}`,
        title: row.representative_title,
        mediaCount: Number(row.media_count),
        articleCount: Number(row.article_count),
        firstSeenAt: row.first_seen_at,
        lastDevelopedAt: row.last_seen_at,
        summary: `Dibahas oleh ${row.media_count} media dengan ${row.article_count} artikel.`,
        timeline: [],
        articles: [],
      };
      byEvent.set(row.event_id, issue);
    }
    issue.articles.push({
      id: `crawl-${row.article_id}`,
      title: row.title,
      source: row.source_id,
      sourceLabel: row.display_name || row.source_id,
      publishedAt: row.published_at || row.collected_at,
      url: row.canonical_url || row.normalized_url || '#',
      thumbnailUrl: row.thumbnail_url || null,
      matchScore: Number(row.match_score),
    });
  }

  return {
    items: Array.from(byEvent.values()).slice(0, limit),
    meta: {
      windowHours,
      availability: 'ready',
      algorithmVersion: run.algorithm_version,
      articlePoolSize: Number(run.article_count),
      clusterCount: Number(run.event_count),
      runId: String(run.run_id),
      finishedAt: run.finished_at,
    },
  };
}

async function readArticles({ page, limit, source, search, db = pool }) {
  const offset = (page - 1) * limit;
  const sourceFilter = source || null;
  const searchFilter = search ? `%${search}%` : null;
  const result = await db.query(
    `SELECT a.article_id, a.title, a.summary, a.content_text,
            a.thumbnail_url, a.published_at, a.author_name,
            a.canonical_url, a.category, a.tags, a.language,
            a.source_id, a.collected_at, s.display_name,
            COUNT(*) OVER() AS total_count
       FROM articles a
       JOIN sources s ON s.source_id = a.source_id
      WHERE a.validation_status = 'valid'
        AND ($1::text IS NULL OR a.source_id = $1)
        AND ($2::text IS NULL OR a.title ILIKE $2 OR COALESCE(a.summary, '') ILIKE $2)
      ORDER BY COALESCE(a.published_at, a.collected_at) DESC, a.article_id DESC
      LIMIT $3 OFFSET $4`,
    [sourceFilter, searchFilter, limit, offset],
  );
  const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
  return {
    items: result.rows.map((row) => ({
      article_id: row.article_id,
      title: row.title,
      summary: row.summary,
      content: row.content_text,
      featured_image: row.thumbnail_url,
      published_at: row.published_at,
      author_name: row.author_name,
      source_url: row.canonical_url,
      category: row.category,
      tags: Array.isArray(row.tags) ? row.tags : [],
      language: row.language,
      source_id: row.source_id,
      source_label: row.display_name || row.source_id,
      collected_at: row.collected_at,
    })),
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

function createServer({ db = pool } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': process.env.API_CORS_ORIGIN || '*',
        'Access-Control-Allow-Headers': 'Accept, Content-Type',
      });
      res.end();
      return;
    }
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      json(res, 200, { ok: true, service: 'egi-media-crawl-api' });
      return;
    }
    const isViralPath = ['/api/v1/news-feed/viral', '/api/viral-poc'].includes(requestUrl.pathname);
    const isArticlesPath = ['/api/v1/news-feed/articles', '/api/crawled-articles'].includes(requestUrl.pathname);
    if (req.method !== 'GET' || (!isViralPath && !isArticlesPath)) {
      json(res, 404, { success: false, data: '', message: 'Not found', code: 404 });
      return;
    }
    try {
      if (isArticlesPath) {
        const page = parsePage(requestUrl.searchParams.get('page'));
        const limit = parseLimit(requestUrl.searchParams.get('limit'));
        json(res, 200, {
          success: true,
          data: await readArticles({
            page,
            limit,
            source: requestUrl.searchParams.get('source'),
            search: requestUrl.searchParams.get('search'),
            db,
          }),
          message: 'Crawled articles loaded',
          code: 200,
        });
        return;
      }
      const windowHours = parseWindow(requestUrl.searchParams.get('window_hours'));
      const limit = parseLimit(requestUrl.searchParams.get('limit'));
      json(res, 200, {
        success: true,
        data: await readIssues(windowHours, limit, db),
        message: 'News feed aggregation loaded',
        code: 200,
      });
    } catch (error) {
      const status = error.status || 503;
      json(res, status, { success: false, data: '', message: error.message, code: status });
    }
  });
}

function listenHost() {
  if (process.env.API_HOST) return process.env.API_HOST;
  // Railway injects PORT. Default 127.0.0.1 would make this API unreachable from other services.
  if (process.env.PORT) return '0.0.0.0';
  return DEFAULT_HOST;
}

if (require.main === module) {
  const server = createServer();
  const host = listenHost();
  const port = Number(process.env.PORT || process.env.API_PORT || DEFAULT_PORT);
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'api_started', host, port })));
  const shutdown = async () => {
    server.close();
    await pool.end();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

module.exports = { createServer, readIssues, readArticles, parseWindow, parseLimit, parsePage };
