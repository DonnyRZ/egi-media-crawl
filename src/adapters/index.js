'use strict';

/**
 * Adapter lookup. Every real adapter must live at
 * `src/adapters/<sourceId>/index.js` and match the contract documented in
 * `src/adapters/_template/index.js`.
 *
 * `_template` is intentionally excluded — it is documentation, not a usable
 * adapter (its methods throw "not implemented").
 *
 * NOTE: `detik` resolves to `./detik/coreAdapter`, not `./detik/index` directly.
 * The raw `./detik/index.js` module (F5) uses the `_template`'s camelCase shape;
 * `./detik/coreAdapter.js` (F6) is a thin mapper to the snake_case shape that
 * `src/core` (runPipeline) and the db layer expect. See that file's header comment
 * for the full contract-mismatch rationale.
 *
 * Same pattern applies to `suara`: it resolves to `./suara/coreAdapter`, which bridges the
 * raw `./suara/index.js` stub's camelCase shape to the core's snake_case shape (see that
 * file's header comment).
 *
 * Sprint 3 adds `cnn_indonesia` (S3-A) and `liputan6` (S3-B) — same bridge pattern again:
 * each resolves to its own `coreAdapter.js`, not the raw `./<sourceId>/index.js`.
 *
 * Sprint 3b adds `tirto` (S3b) — same bridge pattern again, wired in by S3b-D.
 *
 * Sprint 4 adds `tempo` (S4-A), `kumparan` (S4-B), and `jawa_pos` (S4-C) — same bridge
 * pattern again, wired in by S4-D.
 *
 * Sprint 5 adds `okezone` (S5-A) and `sindonews` (S5-B) — same bridge pattern again,
 * wired in by S5-D.
 *
 * Sprint 6a adds `idn_times` (S6a-A), `republika` (S6a-B), and `media_indonesia` (S6a-C) —
 * same bridge pattern again, wired in by S6a-D.
 *
 * Sprint 6b adds `merdeka` (S6b-A), `beritasatu` (S6b-B), and `tribunnews` (S6b-C) — same
 * bridge pattern again, wired in by S6b-D.
 */

const ADAPTER_MODULES = {
  detik: () => require('./detik/coreAdapter'),
  viva: () => require('./viva/coreAdapter'),
  suara: () => require('./suara/coreAdapter'),
  cnn_indonesia: () => require('./cnn_indonesia/coreAdapter'),
  liputan6: () => require('./liputan6/coreAdapter'),
  tirto: () => require('./tirto/coreAdapter'),
  tempo: () => require('./tempo/coreAdapter'),
  kumparan: () => require('./kumparan/coreAdapter'),
  jawa_pos: () => require('./jawa_pos/coreAdapter'),
  okezone: () => require('./okezone/coreAdapter'),
  sindonews: () => require('./sindonews/coreAdapter'),
  idn_times: () => require('./idn_times/coreAdapter'),
  republika: () => require('./republika/coreAdapter'),
  media_indonesia: () => require('./media_indonesia/coreAdapter'),
  merdeka: () => require('./merdeka/coreAdapter'),
  beritasatu: () => require('./beritasatu/coreAdapter'),
  tribunnews: () => require('./tribunnews/coreAdapter'),
};

/**
 * @param {string} sourceId
 * @returns {{getSourceProfile: Function, isArticleUrl: Function, discover: Function, parse: Function}}
 */
function getAdapter(sourceId) {
  const loader = ADAPTER_MODULES[sourceId];
  if (!loader) {
    const known = Object.keys(ADAPTER_MODULES).join(', ');
    throw new Error(`getAdapter: unknown sourceId "${sourceId}". Known adapters: ${known}`);
  }
  return loader();
}

/**
 * @returns {string[]} sourceIds with a registered adapter module.
 */
function listAdapterIds() {
  return Object.keys(ADAPTER_MODULES);
}

module.exports = {
  getAdapter,
  listAdapterIds,
};
