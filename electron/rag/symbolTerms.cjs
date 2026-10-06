'use strict';
// Retrieval-only vocabulary for common technical concepts. No facts or thresholds.
const TERMS = Object.freeze({
  faithfulness: '最终答案支持性校验 事实支持性 断言蕴含 忠实度 answer claims entailment',
  answerability: '可回答性 问题证据充分性 核心事实计划 question requirements sufficiency',
  embedding: '嵌入 向量 语义检索 embedding vector semantic',
  rerank: '重排序 候选排序 rerank relevance',
  checkpoint: '检查点 断点恢复 checkpoint resume',
  idempotency: '幂等 去重 idempotency deduplication',
  citation: '来源引用 引用位置 citation provenance',
  sandbox: '沙箱 隔离执行 sandbox isolation',
});
function symbolTerms(symbol) {
  const tokens = String(symbol || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z]+/g, ' ').toLowerCase().trim().split(/\s+/);
  return [...new Set(tokens.map((token) => TERMS[token]).filter(Boolean))].join(' ');
}
module.exports = { symbolTerms };
