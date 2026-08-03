'use strict';

function intersection(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function weightedJaccard(left, right, documentFrequency) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  const weight = (token) => 1 / Math.log2((documentFrequency.get(token) || 1) + 1);
  let numerator = 0;
  let denominator = 0;
  for (const token of union) {
    const value = weight(token);
    denominator += value;
    if (leftSet.has(token) && rightSet.has(token)) numerator += value;
  }
  return denominator ? numerator / denominator : 0;
}

function lexicalSequence(left, right) {
  const a = left.join(' ');
  const b = right.join(' ');
  if (a === b) return 1;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      matrix[row][column] = a[row - 1] === b[column - 1]
        ? matrix[row - 1][column - 1] + 1
        : Math.max(matrix[row - 1][column], matrix[row][column - 1]);
    }
  }
  return (2 * matrix[a.length][b.length]) / Math.max(1, a.length + b.length);
}

function scoreArticleToEvent(article, representative, stats, options = {}) {
  const sharedAnchors = intersection(article.anchors, representative.anchors);
  const sharedPhrases = intersection(article.phrases, representative.phrases);
  const titleSimilarity = weightedJaccard(article.titleTokens, representative.titleTokens, stats.documentFrequency);
  const sequenceSimilarity = lexicalSequence(article.titleTokens, representative.titleTokens);
  const sharedAllTokens = intersection(article.allTokens, representative.allTokens).length;
  const accepted = (
    (sharedAnchors.length >= (options.minSharedAnchors || 2) && titleSimilarity >= (options.minWeightedJaccard || 0.35)) ||
    (sharedPhrases.length > 0 && sharedAnchors.length >= 1 && titleSimilarity >= (options.phraseJaccard || 0.22)) ||
    (sharedAnchors.length >= 3 && sequenceSimilarity >= 0.72)
  );
  const matchScore = Math.min(1, (titleSimilarity * 0.55) + (sequenceSimilarity * 0.25) + (Math.min(sharedAnchors.length, 5) / 5 * 0.20));
  return {
    accepted,
    matchScore,
    reason: {
      sharedAnchors: sharedAnchors.slice(0, 8),
      sharedPhrases: sharedPhrases.slice(0, 4),
      titleSimilarity: Number(titleSimilarity.toFixed(6)),
      sequenceSimilarity: Number(sequenceSimilarity.toFixed(6)),
      sharedAllTokens,
    },
  };
}

function coverageScore(articleCount, mediaCount) {
  return Number((mediaCount * 10 + Math.log2(Math.max(1, articleCount))).toFixed(4));
}

module.exports = {
  intersection,
  weightedJaccard,
  lexicalSequence,
  scoreArticleToEvent,
  coverageScore,
};
