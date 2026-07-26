#!/usr/bin/env node
'use strict';

// Applies pending SQL migrations from db/migrations, in filename order,
// tracking what has already run in a `schema_migrations` table so re-runs
// are safe (idempotent) and only new files get applied.
//
// Usage: npm run migrate

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((filename) => filename.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

async function applyMigration(client, filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filePath, 'utf8');

  console.log(`[migrate] applying ${filename} ...`);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    console.log(`[migrate] applied ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Failed to apply migration "${filename}": ${err.message}`);
  }
}

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and configure it (expects the egi_crawl database).'
    );
  }

  const files = loadMigrationFiles();
  if (files.length === 0) {
    console.log(`[migrate] no migration files found in ${MIGRATIONS_DIR}`);
    return;
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const pending = files.filter((filename) => !applied.has(filename));

    if (pending.length === 0) {
      console.log(`[migrate] up to date (${applied.size} migration(s) already applied).`);
      return;
    }

    for (const filename of pending) {
      await applyMigration(client, filename);
    }

    console.log(`[migrate] done. ${pending.length} migration(s) applied.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exitCode = 1;
});
