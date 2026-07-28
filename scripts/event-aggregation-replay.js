#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { aggregateEvents } = require('../src/event-aggregation/aggregateEvents');
const { getEventAggregationConfig } = require('../src/event-aggregation/config');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/event-aggregation-replay.js <articles.json> [output.json]');
  process.exit(1);
}
const outputPath = process.argv[3];
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const articles = Array.isArray(input) ? input : input.articles;
if (!Array.isArray(articles)) throw new Error('Replay input must be an article array or an object with an articles array');
const config = getEventAggregationConfig();
const anchorAt = process.env.EVENT_AGGREGATION_REPLAY_ANCHOR || input.anchor || undefined;
const output = {
  algorithm_version: config.algorithmVersion,
  generated_at: new Date().toISOString(),
  windows: Object.fromEntries(config.windows.map((windowHours) => [windowHours, aggregateEvents(articles, { windowHours, anchorAt, algorithmVersion: config.algorithmVersion })])),
};
const json = JSON.stringify(output, null, 2);
if (outputPath) fs.writeFileSync(outputPath, `${json}\n`, 'utf8');
else process.stdout.write(`${json}\n`);
