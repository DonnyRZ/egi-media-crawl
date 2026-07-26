'use strict';

/**
 * Processing statuses for `discovered_urls` / `articles` lifecycle, per playbook §19.6
 * ("Tabel processing_status") and §3.3 ("Delivery reliability").
 *
 * Every URL that enters the system must end up in exactly one of these statuses (or an
 * active/in-flight one) — see §21.4 "Audit listing-to-storage": the target count of URLs
 * with NO status is zero.
 */

/** @type {Object<string,string>} */
const PROCESSING_STATUS = Object.freeze({
  // Active / in-flight states
  DISCOVERED: 'discovered',
  QUEUED: 'queued',
  FETCHING: 'fetching',
  RETRY_SCHEDULED: 'retry_scheduled',
  FETCHED: 'fetched',
  PARSED: 'parsed',
  VALID: 'valid',

  // Terminal states
  STORED: 'stored',
  DUPLICATE: 'duplicate',
  INVALID: 'invalid',
  BLOCKED: 'blocked',
  IGNORED_BY_POLICY: 'ignored_by_policy',
  DEAD_LETTER: 'dead_letter',
});

/**
 * Statuses considered "final" for a given URL/attempt — no further automatic processing is
 * expected once one of these is reached (manual replay per §25.3 is still possible).
 * @type {string[]}
 */
const TERMINAL_STATUSES = Object.freeze([
  PROCESSING_STATUS.STORED,
  PROCESSING_STATUS.DUPLICATE,
  PROCESSING_STATUS.INVALID,
  PROCESSING_STATUS.BLOCKED,
  PROCESSING_STATUS.IGNORED_BY_POLICY,
  PROCESSING_STATUS.DEAD_LETTER,
]);

/**
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isKnownStatus(status) {
  return Object.values(PROCESSING_STATUS).includes(status);
}

module.exports = {
  PROCESSING_STATUS,
  TERMINAL_STATUSES,
  isTerminalStatus,
  isKnownStatus,
};
