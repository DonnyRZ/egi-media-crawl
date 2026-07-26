#!/usr/bin/env node
/**
 * Cross-platform staging scheduler entrypoint.
 * Always sets SCHEDULE_SOURCES=detik,suara and SCHEDULE_INTERVAL_OVERRIDE_MINUTES=2
 * before loading scheduler.js (avoids bash-only `VAR=value node …` on Windows).
 */
'use strict';

// Force staging defaults before dotenv in scheduler.js (dotenv does not override
// existing keys). Matches former bash inline: SCHEDULE_SOURCES=… INTERVAL=… node …
process.env.SCHEDULE_SOURCES = 'detik,suara';
process.env.SCHEDULE_INTERVAL_OVERRIDE_MINUTES = '2';

require('./scheduler.js');
