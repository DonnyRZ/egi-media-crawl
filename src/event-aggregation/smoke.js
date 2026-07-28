'use strict';

const assert = require('assert');
const { aggregateEvents, getEventAggregationConfig, parseWindows } = require('./index');

const articles = [
  { article_id: 1, source_id: 'cnn_indonesia', title: 'Kasus Korupsi Cakra: KPK Tangkap Arman', summary: 'KPK mengumumkan penangkapan Arman.', collected_at: '2026-07-28T10:00:00Z' },
  { article_id: 2, source_id: 'detik', title: 'Arman Ditangkap KPK Terkait Korupsi Cakra', summary: 'Penangkapan diumumkan pada hari ini.', collected_at: '2026-07-28T10:10:00Z' },
  { article_id: 3, source_id: 'tempo', title: 'Tarif Trump Naikkan Harga Impor Asia', summary: 'Kebijakan tarif baru diumumkan.', collected_at: '2026-07-28T10:20:00Z' },
  { article_id: 4, source_id: 'viva', title: 'Perang Negara X dan Y Pecah di Perbatasan', summary: 'Pertempuran dilaporkan terjadi.', collected_at: '2026-07-28T10:30:00Z' },
];

const result = aggregateEvents(articles, { windowHours: 24, anchorAt: '2026-07-28T10:30:00Z' });
assert.strictEqual(result.event_count, 1);
assert.strictEqual(result.events[0].media_count, 2);
assert.strictEqual(result.events[0].article_count, 2);
assert.deepStrictEqual(parseWindows('24,72,72,168'), [24, 72, 168]);
assert.strictEqual(getEventAggregationConfig({ EVENT_AGGREGATION_ENABLED: 'true' }).enabled, true);
  console.log(JSON.stringify({ ok: true, eventCount: result.event_count, event: result.events[0].representative_title }));
