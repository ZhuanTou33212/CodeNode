/** 可选的 Cohere 风格重排接口。默认关闭；失败时调用方保留原 RRF 顺序。 */
'use strict';

async function rerankCandidates(query, candidates, options) {
  const o = options || {};
  if (!candidates.length || (!o.url && !o.client)) return null;
  const release = o.queue ? await o.queue.acquire(o.signal) : null;
  let settleTokens = null;
  let settleCost = null;
  let sent = false;
  let spanDone = false;
  const startedAt = Date.now();
  const span = o.traceProjectRoot ? require('../eventBus.cjs').startSpan(o.traceProjectRoot, {
    spanKind: 'rerank', name: 'rag.rerank', parent: o.traceContext, actor: 'rag',
    attributes: { model: o.model || 'rerank', candidates: candidates.length },
  }) : null;
  try {
    if (o.signal) o.signal.throwIfAborted();
    const inputTokens = Buffer.byteLength(JSON.stringify({ query,
      documents: candidates.map((item) => (item.chunk.path + '\n' + item.chunk.content).slice(0, 2400)) }), 'utf8') + 256;
    if (o.budget) {
      settleTokens = o.budget.reserve(inputTokens);
      settleCost = o.budget.reserveFixedCost(o.maxCostUsd);
    }
    sent = true;
    const result = await rerankInner(query, candidates, o);
    if (span) { span.end('ok', { model: o.model || 'rerank' }); spanDone = true; }
    return result;
  } finally {
    if (span && !spanDone) span.end(o.signal?.aborted ? 'cancelled' : 'error');
    if (settleTokens) settleTokens(sent ? null : { total_tokens: 0 });
    if (settleCost) settleCost(!sent);
    if (sent && typeof o.onUsage === 'function') {
      try {
        o.onUsage({ kind: 'rerank', model: o.model || 'rerank', usage: null, billingUnknown: true,
          estimated: true, latencyMs: Date.now() - startedAt });
      } catch { /* telemetry must not hold a model queue slot */ }
    }
    if (release) release();
  }
}

async function rerankInner(query, candidates, options) {
  const o = options || {};
  if (!candidates.length || (!o.url && !o.client)) return null;
  const documents = candidates.map((item) => (item.chunk.path + '\n' + item.chunk.content).slice(0, 2400));
  let response;
  if (typeof o.client === 'function') {
    response = await o.client({ query, documents, model: o.model || '' });
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(o.timeoutMs) || 10000));
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (o.key) headers.Authorization = 'Bearer ' + o.key;
      const result = await fetch(o.url, {
        method: 'POST', headers, signal: o.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal,
        body: JSON.stringify({ model: o.model || '', query, documents, top_n: documents.length }),
      });
      if (!result.ok) throw new Error('重排服务 HTTP ' + result.status);
      response = await result.json();
    } finally {
      clearTimeout(timer);
    }
  }
  const results = response && Array.isArray(response.results) ? response.results : [];
  const scores = new Map();
  for (const item of results) {
    const index = Number(item.index);
    const score = Number(item.relevance_score);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length || !Number.isFinite(score)) continue;
    scores.set(candidates[index].chunk.id, score);
  }
  if (!scores.size) throw new Error('重排服务未返回有效候选分数');
  return scores;
}

module.exports = { rerankCandidates };
