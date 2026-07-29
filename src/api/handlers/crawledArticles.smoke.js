'use strict';

/**
 * Offline smoke for source filter resolution + pagination clamps (no DB).
 * Run: node src/api/handlers/crawledArticles.smoke.js
 */

const assert = require('assert');
const { resolveSourceIdFilter } = require('../../db/crawledArticlesQuery');
const { parsePagination } = require('./crawledArticles');

assert.strictEqual(resolveSourceIdFilter(null), null);
assert.strictEqual(resolveSourceIdFilter(''), null);
assert.strictEqual(resolveSourceIdFilter('all'), null);
assert.strictEqual(resolveSourceIdFilter('Viral'), null);
assert.strictEqual(resolveSourceIdFilter('EGI Media'), 'egi_media');
assert.strictEqual(resolveSourceIdFilter('egi_media'), 'egi_media');
assert.strictEqual(resolveSourceIdFilter('Detik'), 'detik');
assert.strictEqual(resolveSourceIdFilter('VIVA'), 'viva');
assert.strictEqual(resolveSourceIdFilter('CNN Indonesia'), 'cnn_indonesia');
assert.strictEqual(resolveSourceIdFilter('Liputan6'), 'liputan6');

const p = parsePagination('2', '100');
assert.strictEqual(p.page, 2);
assert.strictEqual(p.limit, 50);

const p2 = parsePagination('-1', '0');
assert.strictEqual(p2.page, 1);
assert.strictEqual(p2.limit, 12);

console.log('[crawled-articles smoke] PASS');
