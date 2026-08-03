'use strict';

const DEFAULT_WINDOWS = [24, 72, 168];

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseWindows(value = process.env.EVENT_AGGREGATION_WINDOWS) {
  const raw = value === undefined ? DEFAULT_WINDOWS : String(value).split(',');
  const windows = raw
    .map((item) => Number.parseInt(String(item).trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 168)
    .filter((item, index, all) => all.indexOf(item) === index)
    .sort((a, b) => a - b);
  return windows.length > 0 ? windows : DEFAULT_WINDOWS.slice();
}

function getEventAggregationConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.EVENT_AGGREGATION_ENABLED, false),
    dryRun: parseBoolean(env.EVENT_AGGREGATION_DRY_RUN, true),
    windows: parseWindows(env.EVENT_AGGREGATION_WINDOWS),
    algorithmVersion: env.EVENT_AGGREGATION_ALGORITHM_VERSION || 'lexical-v1',
    intervalMinutes: Number.parseInt(env.EVENT_AGGREGATION_INTERVAL_MINUTES, 10) || 15,
    maxArticles: Number.parseInt(env.EVENT_AGGREGATION_MAX_ARTICLES, 10) || 10000,
    batchSize: Number.parseInt(env.EVENT_AGGREGATION_BATCH_SIZE, 10) || 5000,
  };
}

module.exports = { DEFAULT_WINDOWS, parseBoolean, parseWindows, getEventAggregationConfig };
