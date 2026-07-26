'use strict';

const pool = require('./pool');

/**
 * Run a single query against the pool.
 * @param {string} text
 * @param {Array<any>} [params]
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Borrow a single client for a sequence of related queries and always
 * release it afterwards.
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run fn inside a BEGIN/COMMIT block on a single client, rolling back on
 * error.
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withTransaction(fn) {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

let closing = null;

/**
 * Drain and close the shared pg Pool. Idempotent — safe under repeated
 * SIGINT/SIGTERM or an explicit worker shutdown call.
 */
function closePool() {
  if (!closing) {
    closing = pool.end().catch((err) => {
      if (err && /Called end on pool more than once/i.test(err.message)) {
        return;
      }
      throw err;
    });
  }
  return closing;
}

module.exports = {
  pool,
  query,
  withClient,
  withTransaction,
  closePool,
};
