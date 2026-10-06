'use strict';
/** Candidate admission is not answerability or entailment. Weak readable evidence may be useful. */
function retrievalAdmission(sources) {
  const readable = (sources || []).filter((source) => typeof source?.citation === 'string' && source.citation.trim() &&
    typeof source?.excerpt === 'string' && source.excerpt.trim());
  return { stage: 'retrieval', status: readable.length ? 'candidates_available' : 'empty',
    admitted: readable.length > 0, candidateCount: readable.length,
    finalSupportEvaluated: false,
    reason: readable.length ? '存在可读候选；可用于生成或继续深读，尚未校验最终结论' : '当前检索未返回可读候选；可改写查询或直接搜索/读取，不代表问题无答案' };
}
function relevanceOnly(quality, admission) {
  const { answerable, evidenceVerified, answerabilityStatus, evidenceChain, ...relevance } = quality || {};
  return { ...relevance, stage: 'retrieval', retrievalAdmitted: admission.admitted,
    reason: (relevance.reason || '') + '；' + admission.reason };
}
module.exports = { retrievalAdmission, relevanceOnly };
