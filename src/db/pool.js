'use strict';

require('dotenv').config();

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[db] DATABASE_URL is not set. Copy .env.example to .env and configure it before running database operations.'
  );
}

const pool = new Pool({
  connectionString,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECT_TIMEOUT_MS || 5000),
});

pool.on('error', (err) => {
  // Errors on idle clients (e.g. connection dropped by the server) must be
  // handled here or they crash the process.
  console.error('[db] unexpected error on idle client', err);
});

module.exports = pool;
