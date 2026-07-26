#!/usr/bin/env node
'use strict';

/**
 * Sprint 10 smoke: minimal ParsedArticle-like object → toEgiArticleRead → assert aliases.
 *
 * Usage: node src/dto/egiArticleRead.smoke.js
 */

const { toEgiArticleRead } = require('./egiArticleRead');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  /** @type {import('../core/types').ParsedArticle} */
  const article = {
    source_id: 'detik',
    requested_url: 'https://news.detik.com/berita/d-1/x',
    final_url: 'https://news.detik.com/berita/d-1/x',
    canonical_url: 'https://news.detik.com/berita/d-1/canonical',
    normalized_url: 'https://news.detik.com/berita/d-1/normalized',
    title: 'Smoke Title',
    content_text: 'Plain body text',
    thumbnail_url: 'https://cdn.example/image.jpg',
    summary: 'A summary',
    published_at: '2026-07-24T10:00:00.000Z',
    author_name: 'Smoke Author',
    content_hash: 'hash_smoke',
    collected_at: '2026-07-24T12:00:00.000Z',
    adapter_version: 'detik_v1',
  };

  const dto = toEgiArticleRead(article);

  assert(Object.prototype.hasOwnProperty.call(dto, 'content'), 'DTO must expose key "content"');
  assert(
    Object.prototype.hasOwnProperty.call(dto, 'featured_image'),
    'DTO must expose key "featured_image"'
  );
  assert(dto.content === article.content_text, 'content must map from content_text');
  assert(
    dto.featured_image === article.thumbnail_url,
    'featured_image must map from thumbnail_url'
  );
  assert(dto.title === article.title, 'title passthrough');
  assert(dto.source_url === article.canonical_url, 'source_url should prefer canonical_url');
  assert(dto.author_name === article.author_name, 'author_name is string passthrough');
  assert(dto.source_id === article.source_id, 'source_id passthrough');

  // Fallback: no canonical_url → normalized_url
  const fallback = toEgiArticleRead({
    ...article,
    canonical_url: '',
  });
  assert(
    fallback.source_url === article.normalized_url,
    'source_url should fall back to normalized_url when canonical_url is empty'
  );

  console.log('[egiArticleRead smoke] PASS');
  console.log(
    JSON.stringify(
      {
        content: dto.content,
        featured_image: dto.featured_image,
        source_url: dto.source_url,
      },
      null,
      2
    )
  );
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('[egiArticleRead smoke] FAIL:', err && err.message ? err.message : err);
  process.exit(1);
}
