'use strict';

function createCandidateIndex() {
  const byAnchor = new Map();
  function add(eventId, anchors) {
    for (const anchor of anchors) {
      if (!byAnchor.has(anchor)) byAnchor.set(anchor, new Set());
      byAnchor.get(anchor).add(eventId);
    }
  }
  function candidates(anchors) {
    const output = new Set();
    for (const anchor of anchors) {
      for (const eventId of byAnchor.get(anchor) || []) output.add(eventId);
    }
    return output;
  }
  return { add, candidates, size: () => byAnchor.size };
}

module.exports = { createCandidateIndex };
