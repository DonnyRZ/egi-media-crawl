'use strict';

const { clusterRecentArticles } = require('../../services/simpleClusteringPoC');

const CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {{ expiresAt: number, payload: object } | null} */
let cache = null;

/**
 * GET /api/viral-poc
 * In-memory TF-IDF clustering over recent crawl articles (5-minute cache).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getViralPoc(req, res) {
  try {
    const forceRefresh =
      String(req.query.refresh || '') === '1' ||
      String(req.query.refresh || '').toLowerCase() === 'true';

    const now = Date.now();
    if (!forceRefresh && cache && cache.expiresAt > now) {
      return res.status(200).json({
        success: true,
        data: {
          ...cache.payload,
          cached: true,
          cache_expires_at: new Date(cache.expiresAt).toISOString(),
        },
      });
    }

    const thresholdRaw = req.query.threshold;
    const hoursRaw = req.query.hours;
    const similarityThreshold =
      thresholdRaw != null && String(thresholdRaw).trim() !== ''
        ? Number(thresholdRaw)
        : undefined;
    const lookbackHours =
      hoursRaw != null && String(hoursRaw).trim() !== ''
        ? Number(hoursRaw)
        : undefined;

    const payload = await clusterRecentArticles({
      similarityThreshold:
        Number.isFinite(similarityThreshold) && similarityThreshold > 0
          ? similarityThreshold
          : undefined,
      lookbackHours:
        Number.isFinite(lookbackHours) && lookbackHours > 0
          ? lookbackHours
          : undefined,
    });

    cache = {
      expiresAt: now + CACHE_TTL_MS,
      payload,
    };

    return res.status(200).json({
      success: true,
      data: {
        ...payload,
        cached: false,
        cache_expires_at: new Date(cache.expiresAt).toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Viral PoC failed';
    console.error(
      JSON.stringify({
        event: 'viral_poc_error',
        message,
        ts: new Date().toISOString(),
      })
    );
    return res.status(500).json({
      success: false,
      error: { message: 'Internal server error' },
    });
  }
}

function clearViralPocCache() {
  cache = null;
}

module.exports = {
  getViralPoc,
  clearViralPocCache,
  CACHE_TTL_MS,
};
