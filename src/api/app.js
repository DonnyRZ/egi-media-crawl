'use strict';

const express = require('express');
const cors = require('cors');
const { getCrawledArticles, getHealth } = require('./handlers/crawledArticles');
const { getViralPoc } = require('./handlers/viralPoc');

/**
 * Default CMS origins allowed to call this read API.
 * Override with CORS_ORIGINS (comma-separated) in .env.
 */
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'https://staging.egi-media.com',
];

/**
 * @returns {string[]}
 */
function resolveCorsOrigins() {
  const raw = process.env.CORS_ORIGINS;
  if (!raw || !String(raw).trim()) {
    return DEFAULT_CORS_ORIGINS;
  }
  return String(raw)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Build the read-only Express app (no listen). Useful for tests.
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();
  const origins = resolveCorsOrigins();

  app.use(
    cors({
      origin(origin, callback) {
        // Allow non-browser clients (curl, server-side) with no Origin header.
        if (!origin || origins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ['GET', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept'],
    })
  );

  app.get('/api/health', getHealth);
  app.get('/api/crawled-articles', getCrawledArticles);
  app.get('/api/viral-poc', getViralPoc);

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: { message: 'Not found' } });
  });

  return app;
}

module.exports = {
  createApp,
  resolveCorsOrigins,
  DEFAULT_CORS_ORIGINS,
};
