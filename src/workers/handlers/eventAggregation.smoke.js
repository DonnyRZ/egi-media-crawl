'use strict';

const assert = require('assert');
const { handleEventAggregation } = require('./eventAggregation');

async function main() {
  const calls = [];
  const result = await handleEventAggregation(
    { data: { runKey: 'smoke-run' } },
    {
      config: { enabled: true, dryRun: true, windows: [24, 72], algorithmVersion: 'lexical-v1', maxArticles: 10, batchSize: 10 },
      getLatestCollectedAt: async () => new Date('2026-07-28T08:00:00Z'),
      getAggregationArticles: async () => [
        { article_id: 1, source_id: 'a', title: 'Korupsi Cakra Arman Ditangkap', summary: '', collected_at: '2026-07-28T07:00:00Z' },
        { article_id: 2, source_id: 'b', title: 'Arman Ditangkap Terkait Korupsi Cakra', summary: '', collected_at: '2026-07-28T07:05:00Z' },
      ],
      persistAggregationResult: async (result, options) => {
        calls.push({ result, options });
        return { dryRun: options.dryRun, persisted: false, eventCount: result.event_count };
      },
    }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.windows.length, 2);
  assert.strictEqual(calls.length, 2);
  assert.ok(calls.every((call) => call.options.dryRun === true));
  console.log(JSON.stringify({ ok: true, windows: result.windows.length, persisted: false }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
