'use strict';

const { normalizeArticle } = require('./normalize');
const { annotateAnchors } = require('./extractAnchors');
const { createCandidateIndex } = require('./candidateIndex');
const { scoreArticleToEvent, coverageScore } = require('./scoring');

function toTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error(`Invalid collected_at: ${value}`);
  return time;
}

function aggregateEvents(inputArticles, options = {}) {
  const algorithmVersion = options.algorithmVersion || 'lexical-v1';
  const windowHours = options.windowHours || 24;
  const anchorAt = options.anchorAt ? new Date(options.anchorAt) : new Date(Math.max(...inputArticles.map((a) => toTime(a.collected_at))));
  const cutoffAt = new Date(anchorAt.getTime() - windowHours * 60 * 60 * 1000);
  const normalized = inputArticles
    .map(normalizeArticle)
    .filter((article) => toTime(article.collected_at) >= cutoffAt.getTime())
    .sort((left, right) => toTime(left.collected_at) - toTime(right.collected_at) || String(left.article_id).localeCompare(String(right.article_id)));
  const { stats, documents } = annotateAnchors(normalized, options);
  const events = [];
  const index = createCandidateIndex();
  let candidateCount = 0;
  let acceptedEdges = 0;
  const maxLinkHours = options.maxLinkHours || 36;

  for (const document of documents) {
    let best = null;
    for (const eventId of index.candidates(document.anchors)) {
      const event = events[eventId];
      if (!event || Math.abs(toTime(document.collected_at) - toTime(event.seed.collected_at)) > maxLinkHours * 60 * 60 * 1000) continue;
      candidateCount += 1;
      const scored = scoreArticleToEvent(document, event.seed, stats, options);
      if (!scored.accepted) continue;
      if (!best || scored.matchScore > best.score) best = { event, eventId, ...scored, score: scored.matchScore };
    }
    if (!best) {
      const eventId = events.length;
      events.push({ seed: document, members: [{ document, matchScore: 1, reason: { seed: true } }] });
      index.add(eventId, document.anchors);
    } else {
      best.event.members.push({ document, matchScore: best.matchScore, reason: best.reason });
      acceptedEdges += 1;
    }
  }

  const outputEvents = events.map((event, eventIndex) => {
    const sourceIds = new Set(event.members.map((member) => member.document.source_id));
    if (sourceIds.size < 2) return null;
    const central = event.members.reduce((best, member) => {
      const score = event.members.reduce((sum, other) => sum + (member.document.titleTokens.filter((token) => other.document.titleTokens.includes(token)).length), 0);
      return !best || score > best.score ? { member, score } : best;
    }, null);
    const firstSeen = event.members.reduce((min, member) => Math.min(min, toTime(member.document.collected_at)), Infinity);
    const lastSeen = event.members.reduce((max, member) => Math.max(max, toTime(member.document.collected_at)), 0);
    const anchorTerms = Array.from(new Set(event.members.flatMap((member) => member.document.anchors))).slice(0, 12);
    const articles = event.members.map((member) => ({
      article_id: member.document.article_id,
      source_id: member.document.source_id,
      title: member.document.title,
      summary: member.document.summary,
      collected_at: member.document.collected_at,
      published_at: member.document.published_at || null,
      match_score: Number(member.matchScore.toFixed(6)),
      match_reason: member.reason,
    }));
    return {
      event_id: eventIndex + 1,
      representative_title: central.member.document.title,
      anchor_terms: anchorTerms,
      article_count: articles.length,
      media_count: sourceIds.size,
      coverage_score: coverageScore(articles.length, sourceIds.size),
      first_seen_at: new Date(firstSeen).toISOString(),
      last_seen_at: new Date(lastSeen).toISOString(),
      algorithm_version: algorithmVersion,
      articles,
    };
  }).filter(Boolean);

  outputEvents.sort((left, right) => right.media_count - left.media_count || right.article_count - left.article_count || left.event_id - right.event_id);
  return {
    algorithm_version: algorithmVersion,
    window_hours: windowHours,
    anchor_at: anchorAt.toISOString(),
    cutoff_at: cutoffAt.toISOString(),
    article_count: documents.length,
    candidate_count: candidateCount,
    accepted_edges: acceptedEdges,
    event_count: outputEvents.length,
    events: outputEvents,
  };
}

module.exports = { aggregateEvents };
