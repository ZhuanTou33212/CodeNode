'use strict';

// Explicit model routing. Candidates never change tools, permissions or shared
// budgets. A new provider receives credentials only from its own declared env.
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const PREFIX = 'agent.model_candidate.';
const ROUTE_PREFIX = 'agent.model_route.';
const FIELDS = Object.freeze({ model: 'model', api_base: 'apiBase', api_protocol: 'protocol',
  api_auth: 'auth', api_endpoint: 'endpoint', api_version: 'apiVersion',
  azure_deployment: 'azureDeployment', anthropic_version: 'anthropicVersion',
  max_tokens_field: 'maxTokensField', api_key_env: 'apiKeyEnv',
  reasoning_effort: 'reasoningEffort', max_tokens: 'maxTokens' });
function invalid(message) {
  return Object.assign(new Error('模型路由配置错误：' + message), { code: 'MODEL_ROUTING_CONFIG_INVALID', retryable: false });
}
function parseConfig(properties = {}) {
  const candidates = Object.create(null);
  const routes = Object.create(null);
  for (const [key, raw] of Object.entries(properties)) {
    if (key.startsWith(PREFIX)) {
      const suffix = key.slice(PREFIX.length);
      const dot = suffix.indexOf('.');
      const id = suffix.slice(0, dot);
      const field = suffix.slice(dot + 1);
      if (dot < 1 || !ID.test(id) || !FIELDS[field]) throw invalid('候选名称或字段无效');
      const value = String(raw == null ? '' : raw).trim();
      candidates[id] ||= {};
      if (field === 'max_tokens') {
        if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw invalid('max_tokens 必须为正整数');
        candidates[id].maxTokens = Number(value);
      } else candidates[id][FIELDS[field]] = value;
    } else if (key.startsWith(ROUTE_PREFIX)) {
      const task = key.slice(ROUTE_PREFIX.length);
      const id = String(raw || '').trim();
      if (!ID.test(task) || !ID.test(id)) throw invalid('任务映射无效');
      routes[task] = id;
    }
  }
  const fallbacks = [...new Set(String(properties['agent.model_fallbacks'] || '').split(',').map(s => s.trim()).filter(Boolean))];
  if (fallbacks.length > 4) throw invalid('最多允许四个备用候选');
  for (const [id, candidate] of Object.entries(candidates)) {
    if (!candidate.model || /[\r\n]/.test(candidate.model)) throw invalid('候选 ' + id + ' 缺少有效 model');
    if (candidate.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate.apiKeyEnv)) throw invalid('凭据环境变量名称无效');
  }
  for (const id of [...fallbacks, ...Object.values(routes)]) {
    if (!ID.test(id) || !candidates[id]) throw invalid('引用了未定义的候选');
  }
  return { candidates, routes, fallbacks };
}
function origin(raw) {
  try { const url = new URL(raw); return url.origin; } catch { throw invalid('api_base 必须是有效 URL'); }
}
function candidateConfig(cfg, candidate) {
  if (!candidate) return cfg;
  const next = { ...cfg, ...candidate };
  delete next.apiKeyEnv;
  // Explicitly supplied provider URL must never silently receive the original key.
  const changesOrigin = candidate.apiBase && origin(candidate.apiBase) !== origin(cfg.apiBase);
  if (changesOrigin && !candidate.apiKeyEnv) throw invalid('跨服务候选必须显式指定 api_key_env');
  if (candidate.apiKeyEnv) {
    const key = process.env[candidate.apiKeyEnv];
    if (!key) throw invalid('候选凭据环境变量尚未设置');
    next.apiKey = key;
  }
  if (changesOrigin) {
    for (const key of ['protocol', 'auth', 'endpoint', 'apiVersion', 'azureDeployment', 'anthropicVersion']) {
      next[key] = candidate[key] || '';
    }
  }
  if (candidate.maxTokens) next.maxTokens = Math.min(Number(cfg.maxTokens) || candidate.maxTokens, candidate.maxTokens);
  if (candidate.reasoningEffort != null && /^(?:|none|off|false|no|-|null|disabled)$/i.test(candidate.reasoningEffort)) next.reasoningEffort = null;
  return next;
}
function selection(cfg, taskType) {
  const routing = cfg.modelRouting || { candidates: {}, routes: {}, fallbacks: [] };
  const task = String(taskType || cfg.modelTaskType || cfg.costKind || 'main');
  const id = routing.routes[task] || (task.startsWith('subagent_') ? routing.routes.subagent : null);
  const entries = [{ id: id || 'primary', cfg: candidateConfig(cfg, id ? routing.candidates[id] : null) }];
  for (const fallback of routing.fallbacks) {
    if (fallback === id) continue;
    entries.push({ id: fallback, cfg: candidateConfig(cfg, routing.candidates[fallback]) });
  }
  return { task, routed: !!id, entries };
}
const STOP_CODES = new Set(['BUDGET_EXCEEDED', 'RETRY_BUDGET_EXCEEDED', 'REQUEST_ATTEMPT_LIMIT',
  'COST_BUDGET_EXCEEDED', 'COST_PRICE_MISSING', 'COST_IMAGE_BOUND_MISSING', 'COST_CONFIG_INVALID', 'MODEL_ROUTING_CONFIG_INVALID', 'TURN_TIMEOUT']);
function failureReason(error) {
  const chain = [];
  for (let next = error; next && chain.length < 8; next = next.cause) chain.push(next);
  if (chain.some(e => STOP_CODES.has(e.code) || e.timedOut)) return null;
  const statusError = chain.find(e => Number.isInteger(e.status));
  if (statusError) return [408, 429, 500, 502, 503, 504].includes(statusError.status) ? 'http-' + statusError.status : null;
  if (chain.some(e => e.code === 'STREAM_INCOMPLETE')) return 'stream-incomplete';
  if (chain.some(e => e.code === 'STREAM_STALLED' || e.stalled)) return 'stream-stalled';
  if (chain.some(e => e.name === 'AbortError' || e.retryable === false && !e.cause)) return null;
  if (chain.some(e => ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(e.code))) return 'network';
  if (chain.some(e => e.name === 'TypeError' && /fetch failed|terminated|network/i.test(e.message))) return 'network';
  return null;
}

/** operation receives the actual candidate and one shared HTTP attempt counter. */
async function run(cfg, options, onEvent, ref, operation) {
  const plan = selection(cfg, options.taskType);
  const emit = event => { if (onEvent) onEvent(event); };
  let index = 0;
  let switches = 0;
  const startedAt = Date.now();
  const timeout = Number(options.timeoutMs);
  if (plan.routed) emit({ kind: 'model_route', taskType: plan.task, candidate: plan.entries[0].id,
    fromModel: cfg.model, model: plan.entries[0].cfg.model, reason: 'configured-task-route' });
  while (true) {
    if (options.signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
    const entry = plan.entries[index];
    const remaining = Number.isFinite(timeout) ? timeout - (Date.now() - startedAt) : undefined;
    if (remaining != null && remaining <= 0) throw Object.assign(new Error('本轮模型请求已达总时长上限'), { code: 'TURN_TIMEOUT', retryable: false });
    // With fallbacks configured, spend retries on the next approved candidate.
    // The overall HTTP ceiling is unchanged and retries still use the root budget.
    const actualCfg = plan.entries.length > 1 ? { ...entry.cfg, reliability: {
      ...entry.cfg.reliability, maxAttempts: 1, streamMaxAttempts: 0,
    } } : entry.cfg;
    try {
      const result = await operation(actualCfg, { ...options,
        ...(remaining == null ? {} : { timeoutMs: remaining }),
        ...(plan.entries.length > 1 ? { streamMaxAttempts: 0 } : {}),
      });
      return { ...result, actualModel: actualCfg.model, modelCandidate: entry.id, modelFallbacks: switches };
    } catch (error) {
      const reason = failureReason(error);
      if (!reason || plan.entries.length <= 1 || options.signal?.aborted || ref.count >= ref.maxAttempts) throw error;
      const nextIndex = Math.min(index + 1, plan.entries.length - 1);
      const next = plan.entries[nextIndex];
      if (nextIndex !== index) switches++;
      const partial = error.streamPartial || error.partial || {};
      emit({ kind: 'stream_restart', attempt: ref.count + 1, maxAttempts: ref.maxAttempts,
        taskType: plan.task, model: next.cfg.model,
        reason: 'model-' + reason, receivedChars: String(partial.content || '').length });
      emit({ kind: nextIndex === index ? 'model_retry' : 'model_fallback', taskType: plan.task,
        fromModel: entry.cfg.model, model: next.cfg.model, candidate: next.id, reason, attempt: ref.count + 1 });
      index = nextIndex;
      if (typeof options.waitForRetry === 'function') await options.waitForRetry(ref.count, options.signal);
    }
  }
}

module.exports = { parseConfig, candidateConfig, selection, failureReason, run };
