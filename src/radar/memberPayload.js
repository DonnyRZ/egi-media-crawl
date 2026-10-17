'use strict';

function memberPayloadSql(alias='member') {
  if(!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new TypeError('Invalid SQL alias');
  return `COALESCE(${alias}.payload,jsonb_build_object(
    'id',${alias}.observation_key,
    'title',${alias}.title,
    'sourceLabel',${alias}.source_label,
    'source',${alias}.source_id,
    'publishedAt',${alias}.published_at,
    'url',substring(${alias}.observation_key from position(':' in ${alias}.observation_key) + 1),
    'evidenceQuality',${alias}.evidence_quality,
    'angleId',${alias}.angle_id,
    'matchScore',${alias}.match_score
  ))`;
}

module.exports={memberPayloadSql};
