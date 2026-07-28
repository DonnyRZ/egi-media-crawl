'use strict';

const STOPWORDS = new Set(
  'yang dan di ke dari untuk dengan ini itu dalam pada juga akan telah adalah sebagai oleh karena tidak lebih menjadi dapat agar atau para seorang sebuah saat setelah sebelum tentang terhadap antara melalui masih sudah bisa ada jadi berita video foto hari tahun bulan ujar kata menurut terkait kasus'.split(' ')
);

const GENERIC_ANCHORS = new Set(
  'polisi pemerintah media berita kasus pihak orang warga hasil korban pejabat resmi nasional negara acara kota dunia viral perang tarif presiden menteri timnas indonesia korupsi tangkap ditangkap menangkap pemeriksaan periksa panggil ditetapkan dugaan'.split(' ')
);

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(value) {
  return fold(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function unique(values) {
  return Array.from(new Set(values));
}

function bigrams(tokens) {
  const output = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    output.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return unique(output);
}

function normalizeArticle(article) {
  if (!article || article.article_id === undefined || !article.source_id) {
    throw new Error('normalizeArticle: article_id and source_id are required');
  }
  const title = String(article.title || '');
  const summary = String(article.summary || '');
  const titleTokens = unique(tokenize(title));
  const summaryTokens = unique(tokenize(summary));
  return {
    ...article,
    title,
    summary,
    collected_at: article.collected_at,
    titleTokens,
    summaryTokens,
    allTokens: unique(titleTokens.concat(summaryTokens)),
    titleBigrams: bigrams(titleTokens),
  };
}

module.exports = {
  STOPWORDS,
  GENERIC_ANCHORS,
  fold,
  tokenize,
  bigrams,
  normalizeArticle,
};
