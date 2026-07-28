'use strict';

const { getEventAggregationConfig } = require('../../event-aggregation/config');
const { aggregateEvents } = require('../../event-aggregation/aggregateEvents');
const { getAggregationArticles, getLatestCollectedAt, persistAggregationResult } = require('../../db/newsEvents');

async function handleEventAggregation(job, deps = {}) {
  const config = deps.config || getEventAggregationConfig();
  if (!config.enabled) return { ok: true, skipped: true, reason: 'disabled' };
  const latest = await (deps.getLatestCollectedAt || getLatestCollectedAt)();
  if (!latest) return { ok: true, skipped: true, reason: 'no_articles' };
  const cutoff = new Date(latest.getTime() - Math.max(...config.windows) * 60 * 60 * 1000);
  const articles = await (deps.getAggregationArticles || getAggregationArticles)({ cutoffAt: cutoff, maxArticles: config.maxArticles });
  const results = [];
  for (const windowHours of config.windows) {
    const result = aggregateEvents(articles, {
      windowHours,
      anchorAt: latest,
      algorithmVersion: config.algorithmVersion,
      batchSize: config.batchSize,
    });
    const persisted = await (deps.persistAggregationResult || persistAggregationResult)(result, {
      dryRun: config.dryRun,
      config,
    });
    results.push({ windowHours, ...persisted, eventCount: result.event_count, articleCount: result.article_count });
    if (deps.log) deps.log('event_aggregation_window_done', results[results.length - 1]);
  }
  return { ok: true, skipped: false, windows: results, runKey: job && job.data && job.data.runKey };
}

module.exports = { handleEventAggregation };
