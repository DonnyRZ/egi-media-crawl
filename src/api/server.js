'use strict';

require('dotenv').config();

const http = require('http');
const { createApp } = require('./app');
const { closePool } = require('../db');

const PORT = Number.parseInt(process.env.API_PORT || '5050', 10) || 5050;
const HOST = process.env.API_HOST || '0.0.0.0';

const app = createApp();
const server = http.createServer(app);

let shuttingDown = false;

function logEvent(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

server.on('error', (err) => {
  const code = err && err.code;
  logEvent('api_listen_error', {
    code,
    message: err && err.message,
    host: HOST,
    port: PORT,
  });

  if (code === 'EADDRINUSE') {
    console.error(
      `[api] Port ${PORT} is already in use. Stop the other process (or set API_PORT) and retry.`
    );
  } else {
    console.error(`[api] Failed to bind ${HOST}:${PORT}:`, err && err.message);
  }

  closePool()
    .catch(() => {})
    .finally(() => process.exit(1));
});

server.listen(PORT, HOST, () => {
  // Guard against Express/Node quirks where the callback can fire even when bind failed.
  if (!server.listening) {
    logEvent('api_listen_callback_without_listening', { host: HOST, port: PORT });
    console.error(
      `[api] Listen callback fired but server is not listening on ${HOST}:${PORT}. Exiting.`
    );
    process.exit(1);
    return;
  }

  const address = server.address();
  logEvent('api_listening', {
    host: HOST,
    port: typeof address === 'object' && address ? address.port : PORT,
    endpoints: ['GET /api/health', 'GET /api/crawled-articles'],
  });
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent('api_shutdown', { signal });

  await new Promise((resolve) => {
    server.close(() => resolve());
  });
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  console.error('[api] uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandledRejection', reason);
  process.exit(1);
});
