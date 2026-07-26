'use strict';

/**
 * Public API of the crawler core (src/core/**).
 *
 * Framework-light by design: no BullMQ, no pg, no live HTTP. Everything network- or
 * storage-related is injected by callers (workers/db layer own those concerns).
 */

const { normalizeUrl, DEFAULT_TRACKING_PARAMS, DEFAULT_TRACKING_PARAM_PREFIXES } = require('./normalizeUrl');
const { computeContentHash, collapseWhitespace } = require('./contentHash');
const { PROCESSING_STATUS, TERMINAL_STATUSES, isTerminalStatus, isKnownStatus } = require('./status');
const { runPipeline } = require('./pipeline');
const { REQUIRED_METHODS, OPTIONAL_METHODS, assertAdapterShape } = require('./adapterContract');
const { resolveDiscoverLimit, parsePositiveInteger } = require('./crawlLimit');
const { REQUIRED_ARTICLE_FIELDS, SOFT_REQUIRED_ARTICLE_FIELDS, N5_OPTIONAL_FIELDS } = require('./fieldContract');
const { getOverlapCutoffAt, getOverlapCutoffIso, isOlderThanCutoff, takeUntilOverlapCutoff } = require('./overlap');
const { parseListingDate, parseListingDateIso } = require('./parseListingDate');

// types.js is JSDoc-only (no runtime exports) and is consumed via `@typedef {import(...)}`.

module.exports = {
  // normalizeUrl.js
  normalizeUrl,
  DEFAULT_TRACKING_PARAMS,
  DEFAULT_TRACKING_PARAM_PREFIXES,

  // contentHash.js
  computeContentHash,
  collapseWhitespace,

  // status.js
  PROCESSING_STATUS,
  TERMINAL_STATUSES,
  isTerminalStatus,
  isKnownStatus,

  // pipeline.js
  runPipeline,

  // adapterContract.js
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  assertAdapterShape,

  // crawlLimit.js
  resolveDiscoverLimit,
  parsePositiveInteger,

  // fieldContract.js
  REQUIRED_ARTICLE_FIELDS,
  SOFT_REQUIRED_ARTICLE_FIELDS,
  N5_OPTIONAL_FIELDS,

  // overlap.js
  getOverlapCutoffAt,
  getOverlapCutoffIso,
  isOlderThanCutoff,
  takeUntilOverlapCutoff,

  // parseListingDate.js
  parseListingDate,
  parseListingDateIso,
};
