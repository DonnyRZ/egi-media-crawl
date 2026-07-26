'use strict';

/**
 * Runtime-checkable description of the Adapter contract (playbook §6.2, §31.3). See
 * `types.js` for the full JSDoc `Adapter` typedef with parameter/return details.
 *
 * Every per-source adapter under `src/sources/**` (owned by F5) must satisfy this shape.
 * This module contains NO source-specific logic — it only documents/validates the contract.
 *
 * Required methods:
 *   - discover(ctx)
 *   - parse(html, ctx)
 *   - isArticleUrl(url, ctx)
 *
 * Optional methods:
 *   - fetchArticle(url, ctx)   — implement only if the source needs adapter-owned fetching;
 *                                by default core fetches via an injected fetchFn (pipeline.js).
 *   - getSourceProfile()
 *   - normalizeUrl(url, ctx)  — source-specific normalization layered on core normalizeUrl.js.
 */

const REQUIRED_METHODS = Object.freeze(['discover', 'parse', 'isArticleUrl']);
const OPTIONAL_METHODS = Object.freeze(['fetchArticle', 'getSourceProfile', 'normalizeUrl']);

/**
 * Validate that a candidate adapter implements the required methods. Throws a descriptive
 * TypeError if not. Does not invoke any adapter method.
 *
 * @param {object} adapter
 * @returns {true}
 */
function assertAdapterShape(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('Adapter must be an object');
  }

  const missing = REQUIRED_METHODS.filter((name) => typeof adapter[name] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`Adapter is missing required method(s): ${missing.join(', ')}`);
  }

  return true;
}

module.exports = {
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  assertAdapterShape,
};
