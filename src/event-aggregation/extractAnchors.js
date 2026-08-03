'use strict';

const { GENERIC_ANCHORS } = require('./normalize');

function buildDocumentFrequency(documents) {
  const frequency = new Map();
  for (const document of documents) {
    for (const token of new Set(document.titleTokens)) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }
  }
  return frequency;
}

function buildPhraseFrequency(documents) {
  const frequency = new Map();
  for (const document of documents) {
    for (const phrase of new Set(document.titleBigrams)) {
      frequency.set(phrase, (frequency.get(phrase) || 0) + 1);
    }
  }
  return frequency;
}

function extractAnchors(document, stats, options = {}) {
  const maxDocumentFrequency = options.maxDocumentFrequency || Math.max(40, Math.floor(stats.documentCount * 0.025));
  const maxPhraseFrequency = options.maxPhraseFrequency || 12;
  const anchors = document.titleTokens.filter((token) => {
    const frequency = stats.documentFrequency.get(token) || 0;
    return frequency <= maxDocumentFrequency && !GENERIC_ANCHORS.has(token);
  });
  const phrases = document.titleBigrams.filter((phrase) => {
    const frequency = stats.phraseFrequency.get(phrase) || 0;
    return frequency <= maxPhraseFrequency && phrase.split(' ').every((token) => !GENERIC_ANCHORS.has(token));
  });
  return {
    anchors: Array.from(new Set(anchors)),
    phrases: Array.from(new Set(phrases)),
  };
}

function annotateAnchors(documents, options = {}) {
  const stats = {
    documentCount: documents.length,
    documentFrequency: buildDocumentFrequency(documents),
    phraseFrequency: buildPhraseFrequency(documents),
  };
  return {
    stats,
    documents: documents.map((document) => ({
      ...document,
      ...extractAnchors(document, stats, options),
    })),
  };
}

module.exports = {
  buildDocumentFrequency,
  buildPhraseFrequency,
  extractAnchors,
  annotateAnchors,
};
