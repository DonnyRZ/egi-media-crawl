'use strict';

const { getAdapter, listAdapterIds } = require('../adapters');

/**
 * Source registry.
 *
 * Loads the SourceProfile for every adapter that has one registered in
 * `src/adapters/index.js`, and exposes the subset that is `enabled`.
 *
 * Adding a new source = adding it to `src/adapters/index.js`'s ADAPTER_MODULES
 * map (the profile's `enabled` flag controls whether the registry surfaces it
 * without needing any code change here).
 */

let cachedEntries = null;

/**
 * @typedef {Object} RegistryEntry
 * @property {string} sourceId
 * @property {import('../adapters/_template').SourceProfile} profile
 * @property {ReturnType<typeof getAdapter>} adapter
 */

/**
 * Builds (and memoizes) the full list of registry entries, one per adapter
 * that exposes a valid SourceProfile.
 *
 * @returns {RegistryEntry[]}
 */
function loadAllSources() {
  if (cachedEntries) {
    return cachedEntries;
  }

  cachedEntries = listAdapterIds().map((sourceId) => {
    const adapter = getAdapter(sourceId);
    const profile = adapter.getSourceProfile();

    if (!profile || profile.sourceId !== sourceId) {
      throw new Error(
        `registry: adapter "${sourceId}" returned an invalid SourceProfile (sourceId mismatch)`
      );
    }

    return { sourceId, profile, adapter };
  });

  return cachedEntries;
}

/**
 * @returns {RegistryEntry[]} only sources whose profile.enabled === true
 */
function loadEnabledSources() {
  return loadAllSources().filter((entry) => entry.profile.enabled);
}

/**
 * @param {string} sourceId
 * @returns {RegistryEntry|undefined}
 */
function getSource(sourceId) {
  return loadAllSources().find((entry) => entry.sourceId === sourceId);
}

/**
 * Clears the memoized registry (mainly useful for tests).
 */
function resetRegistryCache() {
  cachedEntries = null;
}

module.exports = {
  loadAllSources,
  loadEnabledSources,
  getSource,
  resetRegistryCache,
};
