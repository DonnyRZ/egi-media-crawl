'use strict';

/**
 * Lightweight in-memory Viral clustering PoC (TF-IDF + cosine similarity).
 * Read-only against `articles` — no schema changes, no news-event-aggregation code.
 */

const natural = require('natural');
const { query } = require('../db');

const DEFAULT_LOOKBACK_HOURS = 72;
const DEFAULT_SIMILARITY_THRESHOLD = 0.4;
const DEFAULT_MAX_ARTICLES = 250;
const MIN_CLUSTER_SIZE = 2;

// Pre-live fixture articles share this title prefix; they would otherwise
// dominate clusters with near-identical placeholder copy.
const FIXTURE_TITLE_PATTERN = '%Contoh Judul Berita%';

const SOURCE_LABELS = {
  egi_media: 'EGI Media',
  detik: 'Detik',
  viva: 'VIVA',
  cnn_indonesia: 'CNN Indonesia',
  liputan6: 'Liputan6',
  suara: 'Suara',
  tempo: 'Tempo',
  kumparan: 'Kumparan',
  tirto: 'Tirto',
  okezone: 'Okezone',
  sindonews: 'SINDOnews',
  idn_times: 'IDN Times',
  republika: 'Republika',
  media_indonesia: 'Media Indonesia',
  merdeka: 'Merdeka',
  beritasatu: 'BeritaSatu',
  tribunnews: 'Tribunnews',
  jawa_pos: 'Jawa Pos',
};

const ID_STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada', 'ini', 'itu',
  'atau', 'juga', 'akan', 'ada', 'tidak', 'sudah', 'dalam', 'oleh', 'karena',
  'sebagai', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
]);

/**
 * @param {string|null|undefined} text
 * @returns {string}
 */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function tokenizeForTfidf(text) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 2 && !ID_STOPWORDS.has(token))
    .join(' ');
}

/**
 * @param {number} hours
 * @param {number} limit
 */
async function fetchRecentArticles(hours, limit) {
  const { rows } = await query(
    `
    SELECT
      article_id,
      source_id,
      title,
      summary,
      canonical_url,
      normalized_url,
      published_at,
      collected_at
    FROM articles
    WHERE collected_at >= NOW() - ($1::text || ' hours')::interval
      AND title NOT ILIKE $2
    ORDER BY collected_at DESC
    LIMIT $3
    `,
    [String(hours), FIXTURE_TITLE_PATTERN, limit]
  );
  return rows;
}

/**
 * @param {import('natural').TfIdf} tfidf
 * @param {number} docIndex
 * @returns {Map<string, number>}
 */
function sparseVector(tfidf, docIndex) {
  const map = new Map();
  for (const { term, tfidf: weight } of tfidf.listTerms(docIndex)) {
    if (weight > 0) map.set(term, weight);
  }
  return map;
}

/**
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, wa] of a) {
    normA += wa * wa;
    const wb = b.get(term);
    if (wb) dot += wa * wb;
  }
  for (const wb of b.values()) normB += wb * wb;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function createUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = Array.from({ length: n }, () => 0);

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra] += 1;
    }
  }

  return { find, union };
}

/**
 * @param {object} row
 */
function toArticleDto(row) {
  const sourceId = row.source_id;
  const sourceLabel = SOURCE_LABELS[sourceId] || sourceId;
  const published = row.published_at || row.collected_at;
  return {
    id: String(row.article_id),
    title: row.title,
    sourceLabel,
    source: sourceLabel,
    source_id: sourceId,
    publishedAt: published ? new Date(published).toISOString() : null,
    url: row.canonical_url || row.normalized_url || null,
  };
}

/**
 * @param {object[]} members
 */
function buildCluster(members) {
  const sortedByLen = [...members].sort(
    (a, b) => String(b.title || '').length - String(a.title || '').length
  );
  const representative = sortedByLen[0];
  const issueTitle = representative.title;

  const times = members
    .map((m) => new Date(m.published_at || m.collected_at).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const firstSeenAt = times.length ? new Date(times[0]).toISOString() : null;
  const lastDevelopedAt = times.length
    ? new Date(times[times.length - 1]).toISOString()
    : null;

  const sources = [...new Set(members.map((m) => m.source_id))];
  const channelCount = sources.length;
  const articleCount = members.length;

  const summary =
    members.find((m) => m.summary && String(m.summary).trim())?.summary ||
    `${articleCount} articles across ${channelCount} channels (TF-IDF PoC).`;

  const sourceLabels = sources.map((id) => SOURCE_LABELS[id] || id);
  const timeline = [
    {
      id: `${representative.article_id}-first`,
      label: 'First seen',
      at: firstSeenAt,
      detail: firstSeenAt
        ? `Earliest coverage among ${sourceLabels.slice(0, 3).join(', ')}${sourceLabels.length > 3 ? '…' : ''}.`
        : 'No timestamp available.',
    },
    {
      id: `${representative.article_id}-last`,
      label: 'Last developed',
      at: lastDevelopedAt,
      detail: `Cluster updated with ${articleCount} related articles.`,
    },
  ];

  return {
    id: `poc-${representative.article_id}`,
    // Frontend ViralIssue shape
    title: issueTitle,
    mediaCount: channelCount,
    articleCount,
    firstSeenAt,
    lastDevelopedAt,
    summary,
    timeline,
    articles: members.map(toArticleDto),
    // Explicit aliases requested for the PoC contract
    issueTitle,
    channelCount,
  };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.lookbackHours]
 * @param {number} [opts.similarityThreshold]
 * @param {number} [opts.maxArticles]
 */
async function clusterRecentArticles(opts = {}) {
  const lookbackHours = opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxArticles = opts.maxArticles ?? DEFAULT_MAX_ARTICLES;

  const rows = await fetchRecentArticles(lookbackHours, maxArticles);
  if (rows.length === 0) {
    return {
      items: [],
      meta: {
        lookbackHours,
        similarityThreshold: threshold,
        articlePoolSize: 0,
        clusterCount: 0,
        engine: 'tfidf-cosine-poc',
      },
    };
  }

  const tfidf = new natural.TfIdf();
  const docs = rows.map((row) => {
    const blob = tokenizeForTfidf(`${row.title || ''} ${row.summary || ''}`);
    return blob || tokenizeForTfidf(row.title || 'untitled');
  });
  docs.forEach((doc) => tfidf.addDocument(doc));

  const vectors = docs.map((_, i) => sparseVector(tfidf, i));
  const uf = createUnionFind(rows.length);

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim >= threshold) uf.union(i, j);
    }
  }

  /** @type {Map<number, object[]>} */
  const groups = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(rows[i]);
  }

  const items = [...groups.values()]
    .filter((members) => members.length >= MIN_CLUSTER_SIZE)
    .map(buildCluster)
    .sort((a, b) => {
      if (b.channelCount !== a.channelCount) return b.channelCount - a.channelCount;
      if (b.articleCount !== a.articleCount) return b.articleCount - a.articleCount;
      return String(b.lastDevelopedAt || '').localeCompare(String(a.lastDevelopedAt || ''));
    });

  return {
    items,
    meta: {
      lookbackHours,
      similarityThreshold: threshold,
      articlePoolSize: rows.length,
      clusterCount: items.length,
      engine: 'tfidf-cosine-poc',
    },
  };
}

module.exports = {
  clusterRecentArticles,
  cosineSimilarity,
  normalizeText,
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_SIMILARITY_THRESHOLD,
};
