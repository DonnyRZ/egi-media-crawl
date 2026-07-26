'use strict';

const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let sharedConnection = null;

/**
 * BullMQ requires the underlying ioredis connection to be created with
 * `maxRetriesPerRequest: null` and (recommended) `enableReadyCheck: false`,
 * otherwise its internal blocking commands (used for waiting on new jobs)
 * can time out or be rejected. See BullMQ docs on "Connections".
 *
 * This module does not require Postgres and has no dependency on src/db —
 * queue-only usage (enqueue/inspect) works even before F2's migrations run.
 */
function createConnection(overrides = {}) {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...overrides,
  });
}

/**
 * Returns a single shared ioredis connection reused by every Queue/Worker in
 * this process. BullMQ internally duplicates the connection when it needs a
 * dedicated blocking client, so sharing this instance across queues/workers
 * is safe and avoids opening one TCP connection per queue.
 */
function getConnection() {
  if (!sharedConnection) {
    sharedConnection = createConnection();
    sharedConnection.on('error', (err) => {
      console.error('[queue:connection] Redis connection error:', err.message);
    });
  }
  return sharedConnection;
}

async function closeConnection() {
  if (sharedConnection) {
    const conn = sharedConnection;
    sharedConnection = null;
    await conn.quit().catch(() => conn.disconnect());
  }
}

module.exports = {
  REDIS_URL,
  createConnection,
  getConnection,
  closeConnection,
};
