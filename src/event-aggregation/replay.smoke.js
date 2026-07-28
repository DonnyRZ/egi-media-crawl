'use strict';

const assert = require('assert');
const { aggregateEvents } = require('./aggregateEvents');

const replayArticles = [
  { article_id: 1, source_id: 'cnn_indonesia', title: 'KPK Tangkap Arman dalam Kasus Korupsi Cakra', summary: 'KPK menangkap Arman.', collected_at: '2026-07-28T08:00:00Z', published_at: '2026-07-28T07:55:00Z' },
  { article_id: 2, source_id: 'detik', title: 'Arman Ditangkap KPK Terkait Korupsi Cakra', summary: 'Penangkapan Arman diumumkan.', collected_at: '2026-07-28T08:10:00Z', published_at: '2026-07-28T08:00:00Z' },
  { article_id: 3, source_id: 'tempo', title: 'Tarif Trump Naikkan Harga Impor Asia', summary: 'Tarif baru diumumkan.', collected_at: '2026-07-28T08:20:00Z', published_at: '2026-07-28T08:10:00Z' },
  { article_id: 4, source_id: 'viva', title: 'Perang Negara X dan Y Pecah di Perbatasan', summary: 'Pertempuran dilaporkan.', collected_at: '2026-07-28T08:30:00Z', published_at: '2026-07-28T08:20:00Z' },
  { article_id: 5, source_id: 'cnn_indonesia', title: 'KPK Tangkap Arman dalam Kasus Korupsi Cakra', summary: 'Duplikat dari sumber yang sama.', collected_at: '2026-07-28T08:40:00Z', published_at: '2026-07-28T08:35:00Z' },
];

const options = { windowHours: 24, anchorAt: '2026-07-28T08:40:00Z', algorithmVersion: 'lexical-v1' };
const first = aggregateEvents(replayArticles, options);
const second = aggregateEvents(replayArticles, options);
assert.deepStrictEqual(first, second, 'same input must produce deterministic output');
assert.strictEqual(first.event_count, 1, 'only the cross-media corruption event should persist');
assert.strictEqual(first.events[0].media_count, 2);
assert.strictEqual(first.events[0].article_count, 3);
assert.ok(!JSON.stringify(first).includes('Tarif Trump'));
assert.ok(!JSON.stringify(first).includes('Perang Negara'));

const boundary = aggregateEvents([
  { article_id: 10, source_id: 'a', title: 'Kasus Cakra Arman Ditangkap', summary: '', collected_at: '2026-07-27T08:40:00Z' },
  { article_id: 11, source_id: 'b', title: 'Arman Ditangkap dalam Kasus Cakra', summary: '', collected_at: '2026-07-27T08:39:59Z' },
], { windowHours: 24, anchorAt: '2026-07-28T08:40:00Z' });
assert.strictEqual(boundary.article_count, 1, 'article outside the exact 24h cutoff must be excluded');
assert.strictEqual(boundary.event_count, 0, 'one remaining source cannot form a cross-media event');

const sameSource = aggregateEvents([
  { article_id: 20, source_id: 'a', title: 'Kasus Cakra Arman Ditangkap', summary: '', collected_at: '2026-07-28T08:00:00Z' },
  { article_id: 21, source_id: 'a', title: 'Arman Ditangkap dalam Kasus Cakra', summary: '', collected_at: '2026-07-28T08:05:00Z' },
], options);
assert.strictEqual(sameSource.event_count, 0, 'same-source articles cannot form a cross-media event');

const changedEntity = aggregateEvents([
  { article_id: 30, source_id: 'a', title: 'Korupsi Cakra Arman Ditangkap', summary: '', collected_at: '2026-07-28T08:00:00Z' },
  { article_id: 31, source_id: 'b', title: 'Korupsi Bima Damar Ditangkap', summary: '', collected_at: '2026-07-28T08:05:00Z' },
], options);
assert.strictEqual(changedEntity.event_count, 0, 'different entities must not be grouped by generic action words');
console.log(JSON.stringify({ ok: true, deterministic: true, eventCount: first.event_count, articleCount: first.events[0].article_count }));
