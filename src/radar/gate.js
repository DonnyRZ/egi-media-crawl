'use strict';
function validateGate(report) {
  return !!report && report.reviewers?.length>=2 && new Set(report.reviewers).size>=2 &&
    report.pairs>=500 && report.events>=100 && report.precision>=.95 && report.recall>=.85 &&
    report.topTenUseful>=8 && report.shadowHours>=168 && report.inputComplete===true &&
    report.sourceCoverageReviewed===true && report.algorithmVersion==='editorial-radar-v2';
}
function loadGate(env=process.env,cohortVersion) {
  if(!env.RADAR_APPROVAL_FILE)return false;
  try {const report=JSON.parse(require('node:fs').readFileSync(env.RADAR_APPROVAL_FILE,'utf8'));return validateGate(report) && report.cohortVersion===cohortVersion;}catch{return false;}
}
module.exports={validateGate,loadGate};
