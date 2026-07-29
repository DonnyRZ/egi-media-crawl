'use strict';

require('dotenv').config();

const { createApp } = require('./app');
const { closePool } = require('../db');

const PORT = Number.parseInt(process.env.API_PORT || '5050', 10) || 5050;

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      event: 'api_listening',
      port: PORT,
      ts: new Date().toISOString(),
      endpoints: ['GET /api/health', 'GET /api/crawled-articles'],
    })
  );
});

async function shutdown(signal) {
  console.log(JSON.stringify({ event: 'api_shutdown', signal, ts: new Date().toISOString() }));
  await new Promise((resolve) => server.close(resolve));
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});
