'use strict';

const crypto = require('crypto');

/**
 * Content fingerprinting for deduplication (playbook §18.5 "Content fingerprint"):
 *
 *   SHA-256(normalized title + normalized content)
 *
 * Used to detect the same article under different URLs (slug changes, mobile vs desktop
 * URLs, republished content) even when normalized_url/canonical_url differ.
 */

/**
 * Collapse all whitespace runs (spaces, tabs, newlines) into a single space and trim the
 * ends. This is intentionally the ONLY normalization applied before hashing — no
 * lowercasing, no punctuation stripping — so the hash stays predictable and cheap to
 * reason about. Callers needing case-insensitive matching should compare hashes computed
 * with consistently-cased inputs, or add their own normalization before calling this.
 *
 * @param {string} value
 * @returns {string}
 */
function collapseWhitespace(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} title
 * @param {string} content
 * @returns {string} lowercase-hex SHA-256 digest
 */
function computeContentHash(title, content) {
  const normalizedTitle = collapseWhitespace(title);
  const normalizedContent = collapseWhitespace(content);
  const payload = `${normalizedTitle}\n${normalizedContent}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

module.exports = {
  computeContentHash,
  collapseWhitespace,
};
