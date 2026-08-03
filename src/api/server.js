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
    if (req.method !== 'GET' || !['/api/v1/news-feed/viral', '/api/viral-poc'].includes(requestUrl.pathname)) {
      json(res, 404, { success: false, data: '', message: 'Not found', code: 404 });
      return;
    }
    try {
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

if (require.main === module) {
  const server = createServer();
  const host = process.env.API_HOST || DEFAULT_HOST;
  const port = Number(process.env.API_PORT || DEFAULT_PORT);
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'api_started', host, port })));
  const shutdown = async () => {
    server.close();
    await pool.end();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

module.exports = { createServer, readIssues, parseWindow, parseLimit };
