#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { enqueueEventAggregation } = require('../src/queue/enqueue');
const { closeQueues } = require('../src/queue/queues');

enqueueEventAggregation({ runKey: process.env.EVENT_AGGREGATION_RUN_KEY || new Date().toISOString() })
  .then((job) => {
    console.log(JSON.stringify({ ok: true, jobId: job.id, queue: 'crawl-event-aggregation' }));
  })
  .catch((error) => {
    console.error('[event-aggregation-once] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => closeQueues());
