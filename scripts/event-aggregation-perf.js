#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { aggregateEvents } = require('../src/event-aggregation/aggregateEvents');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/event-aggregation-perf.js <articles.json>');
  process.exit(1);
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const articles = Array.isArray(input) ? input : input.articles;
const anchorAt = input.anchor || undefined;
for (const windowHours of [24, 72, 168]) {
  const before = process.hrtime.bigint();
  const result = aggregateEvents(articles, { windowHours, anchorAt, algorithmVersion: 'lexical-v1' });
  const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
  const rssMb = process.memoryUsage().rss / (1024 * 1024);
  console.log(JSON.stringify({ windowHours, articleCount: result.article_count, candidateCount: result.candidate_count, eventCount: result.event_count, elapsedMs: Number(elapsedMs.toFixed(2)), rssMb: Number(rssMb.toFixed(2)) }));
}
