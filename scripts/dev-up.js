#!/usr/bin/env node
/**
 * Local bring-up: docker compose stack → wait healthy → migrate.
 * Does not start the worker (leave that to `npm start` / `npm run dev` in a dedicated terminal).
 * Cross-platform (Windows + Unix) via child_process + docker CLI.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAX_WAIT_MS = 90_000;
const POLL_MS = 2_000;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.stdio || 'inherit',
    encoding: 'utf8',
    ...opts,
  });
  return result;
}

function compose(args, opts) {
  return run('docker', ['compose', ...args], opts);
}

function serviceHealthy(service) {
  const result = compose(['ps', '--format', 'json', service], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return false;
  const out = (result.stdout || '').trim();
  if (!out) return false;
  try {
    // docker compose may emit one JSON object per line, or a JSON array
    const lines = out.split(/\r?\n/).filter(Boolean);
    const rows = lines.flatMap((line) => {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    });
    return rows.some((row) => {
      const health = String(row.Health || row.State || '').toLowerCase();
      return health === 'healthy' || health.includes('healthy');
    });
  } catch {
    return /healthy/i.test(out);
  }
}

function sleep(ms) {
  // Cross-platform sync sleep without busy-spinning the event loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitHealthy(services) {
  const start = Date.now();
  process.stdout.write(`[dev-up] waiting for healthy: ${services.join(', ')}`);
  while (Date.now() - start < MAX_WAIT_MS) {
    if (services.every(serviceHealthy)) {
      process.stdout.write(' — ok\n');
      return;
    }
    process.stdout.write('.');
    sleep(POLL_MS);
  }
  process.stdout.write('\n');
  console.error(
    `[dev-up] timed out after ${MAX_WAIT_MS / 1000}s waiting for: ${services.join(', ')}.\n` +
      '  Check: npm run stack:ps   and   docker compose logs'
  );
  process.exit(1);
}

function main() {
  console.log('[dev-up] starting crawl stack (postgres + redis)…');
  const up = compose(['up', '-d']);
  if (up.status !== 0) {
    console.error(
      '[dev-up] `docker compose up -d` failed. Is Docker running? Is docker-compose.yml present (S11-A)?'
    );
    process.exit(up.status || 1);
  }

  waitHealthy(['postgres', 'redis']);

  console.log('[dev-up] applying migrations…');
  const migrate = run(process.execPath, [path.join('scripts', 'migrate.js')]);
  if (migrate.status !== 0) {
    console.error('[dev-up] migrate failed. Check DATABASE_URL in .env (expect localhost:5434/egi_crawl).');
    process.exit(migrate.status || 1);
  }

  console.log(`
[dev-up] stack is up and migrations applied.

  Next:
    npm start                 # long-lived worker (needs REDIS_URL)
    npm run schedule:staging  # optional: register detik+suara @ 2m (fixture-first)
    npm run schedule:all      # optional: register all adapters (fixture-first; profile intervals)
    npm run crawl:once -- --source=detik   # optional: one-shot, no Redis
    npm run report            # optional: crawl report (Postgres only)
    npm run report:check      # optional: report + health thresholds (exit 2 on breach)

  Tear down (keeps volumes):  npm run stack:down
`);
}

main();
