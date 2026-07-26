'use strict';

/**
 * Smoke: exercise worker graceful shutdown without relying on OS signals.
 *
 * On Windows, `child.kill('SIGTERM')` terminates Node immediately and never
 * runs process signal handlers — so this script imports the worker module and
 * calls the exported `shutdown()` (same path SIGINT/SIGTERM invoke).
 *
 * Verifies:
 *   - workers start
 *   - shutdown_started / shutdown_complete log events
 *   - idempotent double-call (second signal shares one promise)
 *   - resources close without hang
 *
 * Usage (Redis + Postgres up; fixture-first defaults unchanged):
 *   npm run smoke:shutdown
 */

require('dotenv').config();

const { startWorkers, shutdown } = require('../src/workers');

const OVERALL_TIMEOUT_MS = Number(process.env.SMOKE_SHUTDOWN_TIMEOUT_MS || 45_000);

function fail(msg) {
  console.error(`[smoke-shutdown] FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    const text = args.map(String).join(' ');
    lines.push(text);
    originalLog.apply(console, args);
  };

  const forceTimer = setTimeout(() => {
    fail(`timed out after ${OVERALL_TIMEOUT_MS}ms (hang during shutdown?)`);
  }, OVERALL_TIMEOUT_MS);

  let workers;
  try {
    workers = startWorkers();

    // First call + concurrent second call (simulates SIGINT then SIGTERM).
    const first = shutdown(workers, 'SIGTERM', { exitProcess: false });
    const second = shutdown(workers, 'SIGINT', { exitProcess: false });
    await Promise.all([first, second]);
  } catch (err) {
    clearTimeout(forceTimer);
    console.log = originalLog;
    fail(err && err.message ? err.message : String(err));
    return;
  }

  clearTimeout(forceTimer);
  console.log = originalLog;

  const events = lines
    .flatMap((line) => {
      try {
        const obj = JSON.parse(line);
        return obj && obj.event ? [obj.event] : [];
      } catch {
        return [];
      }
    });

  const required = [
    'workers_started',
    'shutdown_started',
    'shutdown_already_in_progress',
    'shutdown_complete',
  ];
  const missing = required.filter((e) => !events.includes(e));
  if (missing.length) {
    fail(`missing log events: ${missing.join(', ')} (saw: ${events.join(', ')})`);
  }

  console.log(
    JSON.stringify({
      event: 'smoke_shutdown_result',
      ts: new Date().toISOString(),
      ok: true,
      events: required,
      note: 'Invoked exported shutdown() (Windows-safe). SIGINT/SIGTERM handlers call the same function.',
    })
  );
  console.log('[smoke-shutdown] OK');
  // Worker.shutdown() with exitProcess:false closes owned clients, but BullMQ may
  // leave brief duplicate-connection handles; force exit so the smoke does not hang.
  process.exit(0);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
