/**
 * plan.cjs —— Agent 任务清单（`update_plan` 工具的唯一实现来源）
 *
 * 为什么需要它（对照 Codex 的 `update_plan` / Claude Code 的 TodoWrite）：
 * 此前 harness 只有**机器注入**的进度条（`agent.cjs` 的 buildProgressNote：轮次/调用数/改动文件），
 * 模型自己没有任何地方可以写下"这件事我分几步、现在在哪一步"。长任务于是只剩两个状态：
 * 闷头调到撞上 `agent.max_tool_iterations`，或者漂到别的目标上。进度条告诉模型"用了多少次调用"，
 * 计划告诉模型"承诺过做什么、还差什么"——两者不可互相替代。
 *
 * 设计约束（都对应一条实测判据）：
 *   1. **计划必须能被模型重新看到**：只把结果回给当轮不够 —— 后续轮次靠进度提示一起回灌
 *      （`buildProgressNote` 接 plan），否则模型 5 轮后就不记得自己承诺过什么。
 *   2. **状态必须落盘**：run 事件 + `.codenode/runs/<runId>.plan.json`（与 `.subagents.json` 同口径），
 *      跨进程/续跑/界面回放都查得到；只在内存里等于刷新即失忆。
 *   3. **同一时刻最多一个 `in_progress`**：这条是判据本身 —— 允许多个 in_progress 等于允许"同时在
 *      做三件事"，计划会退化成愿望清单。超出就直接报参数错误让模型改，而不是静默挑一个。
 *   4. **不做确认**：它是 Agent 的内部状态，不是对世界的写操作（不碰文件/画布），与 Codex/Claude Code 一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFile } = require('./atomicFile.cjs');

/** 单份计划最多多少项（与 schema 的 maxItems 保持一致） */
const MAX_PLAN_ITEMS = 20;
/** 单个步骤最多多少字符（与 schema 的 maxLength 保持一致） */
const MAX_STEP_CHARS = 200;
const MAX_STEP_ID_CHARS = 80;
const MAX_ACCEPTANCE_CHARS = 240;
const MAX_REASON_CHARS = 300;
const MAX_EVIDENCE_CALLS = 8;
const MAX_DEPENDENCIES = 20;
/** 合法状态 */
const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'blocked', 'completed', 'cancelled']);
/** 状态 → 渲染标记 */
const STATUS_MARKS = Object.freeze({ pending: '[ ]', in_progress: '[→]', blocked: '[!]', completed: '[x]', cancelled: '[-]' });

/** `.codenode/runs/<runId>.plan.json`（runId 与 subagents 视图同口径做安全化） */
function planFile(projectRoot, runId) {
  const safe = String(runId || 'unscoped').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs', safe + '.plan.json');
}

/** 稳定的每会话最新计划路径；独立于 run，避免不同画布间串计划。 */
function sessionPlanFile(projectRoot, sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe) return null;
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'plans', safe + '.json');
}

/**
 * 校验并归一化 items（不落盘、不依赖上下文，纯函数）。
 * 失败分支带 error + code（供工具直接回给模型，让它改参数重试）。
 * @param {any} rawItems
 * @param {{previousItems?: Array<any>}} [options]
 * @returns {{ok: true, items: Array<{id: string, step: string, acceptanceCriteria: string, status: string, evidenceCallIds?: string[], reason?: string, dependsOn?: string[], ownerTaskId?: string}>}|{ok: false, error: string, code: string}}
 */
function normalizePlan(rawItems, options = {}) {
  if (!Array.isArray(rawItems)) {
    return { ok: false, error: '参数 items 必须是数组', code: 'ARG_SCHEMA' };
  }
  if (rawItems.length === 0) {
    // 空计划没有语义：想清空请给一项 "（无待办）" 之类的显式步骤，而不是发一个空数组
    return { ok: false, error: '参数 items 不能为空数组（至少要有一项）', code: 'ARG_SCHEMA' };
  }
  if (rawItems.length > MAX_PLAN_ITEMS) {
    return { ok: false, error: `计划最多 ${MAX_PLAN_ITEMS} 项（当前 ${rawItems.length} 项）`, code: 'ARG_SCHEMA' };
  }
  const items = [];
  let inProgress = 0;
  const previousItems = Array.isArray(options.previousItems) ? options.previousItems : [];
  const previousByText = new Map();
  for (const old of previousItems) {
    if (!old || !old.id || !old.step) continue;
    const key = String(old.step).trim();
    if (!previousByText.has(key)) previousByText.set(key, []);
    previousByText.get(key).push(old);
  }
  const usedIds = new Set();
  for (let i = 0; i < rawItems.length; i += 1) {
    const raw = rawItems[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `items[${i}] 必须是 {step, status} 对象`, code: 'ARG_SCHEMA' };
    }
    const step = String(raw.step == null ? '' : raw.step).trim();
    if (!step) return { ok: false, error: `items[${i}].step 不能为空`, code: 'ARG_SCHEMA' };
    if (step.length > MAX_STEP_CHARS) {
      return { ok: false, error: `items[${i}].step 超过 ${MAX_STEP_CHARS} 字符`, code: 'ARG_SCHEMA' };
    }
    let id = String(raw.id == null ? '' : raw.id).trim();
    if (!id) {
      const matches = previousByText.get(step) || [];
      const priorMatch = matches.find((candidate) => !usedIds.has(String(candidate.id)));
      id = priorMatch ? String(priorMatch.id) : 'step-' + crypto.createHash('sha1').update(step).digest('hex').slice(0, 10);
      let suffix = 2;
      while (usedIds.has(id)) id = 'step-' + crypto.createHash('sha1').update(step).digest('hex').slice(0, 10) + '-' + suffix++;
    }
    if (id.length > MAX_STEP_ID_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      return { ok: false, error: `items[${i}].id 必须是最多 ${MAX_STEP_ID_CHARS} 字符的字母、数字、点、下划线或连字符`, code: 'ARG_SCHEMA' };
    }
    if (usedIds.has(id)) return { ok: false, error: `items[${i}].id 重复：${id}`, code: 'ARG_SEMANTIC' };
    usedIds.add(id);
    const previous = previousItems.find((candidate) => candidate && String(candidate.id) === id);
    const acceptanceCriteria = String(raw.acceptanceCriteria == null ? (previous && previous.acceptanceCriteria) || '' : raw.acceptanceCriteria).trim();
    if (!acceptanceCriteria) return { ok: false, error: `items[${i}].acceptanceCriteria 不能为空（写清这一步如何验收）`, code: 'ARG_SCHEMA' };
    if (acceptanceCriteria.length > MAX_ACCEPTANCE_CHARS) return { ok: false, error: `items[${i}].acceptanceCriteria 超过 ${MAX_ACCEPTANCE_CHARS} 字符`, code: 'ARG_SCHEMA' };
    const status = String(raw.status == null ? '' : raw.status).trim();
    if (!PLAN_STATUSES.includes(status)) {
      return { ok: false, error: `items[${i}].status 必须是 ${PLAN_STATUSES.join('|')} 之一`, code: 'ARG_SCHEMA' };
    }
    if (status === 'in_progress') inProgress += 1;
    const evidenceInput = raw.evidenceCallIds == null ? (previous && previous.evidenceCallIds) || [] : raw.evidenceCallIds;
    if (!Array.isArray(evidenceInput) || evidenceInput.length > MAX_EVIDENCE_CALLS) {
      return { ok: false, error: `items[${i}].evidenceCallIds 必须是最多 ${MAX_EVIDENCE_CALLS} 项的数组`, code: 'ARG_SCHEMA' };
    }
    const evidenceCallIds = evidenceInput.map((callId) => String(callId || '').trim()).filter(Boolean);
    const reason = String(raw.reason == null ? (previous && previous.reason) || '' : raw.reason).trim();
    if ((status === 'blocked' || status === 'cancelled') && !reason) {
      return { ok: false, error: `items[${i}] 状态为 ${status} 时必须填写 reason`, code: 'ARG_SCHEMA' };
    }
    if (reason.length > MAX_REASON_CHARS) return { ok: false, error: `items[${i}].reason 超过 ${MAX_REASON_CHARS} 字符`, code: 'ARG_SCHEMA' };
    if (status === 'completed' && evidenceCallIds.length === 0) {
      return { ok: false, error: `items[${i}] 标记 completed 前必须关联成功工具调用 evidenceCallIds`, code: 'ARG_SEMANTIC' };
    }
    const dependencyInput = raw.dependsOn == null ? (previous && previous.dependsOn) || [] : raw.dependsOn;
    if (!Array.isArray(dependencyInput) || dependencyInput.length > MAX_DEPENDENCIES) {
      return { ok: false, error: `items[${i}].dependsOn 必须是最多 ${MAX_DEPENDENCIES} 项的步骤 ID 数组`, code: 'ARG_SCHEMA' };
    }
    const dependsOn = dependencyInput.map((dependency) => String(dependency || '').trim()).filter(Boolean);
    if (new Set(dependsOn).size !== dependsOn.length) {
      return { ok: false, error: `items[${i}].dependsOn 含重复步骤 ID`, code: 'ARG_SEMANTIC' };
    }
    const ownerTaskId = String(raw.ownerTaskId == null ? (previous && previous.ownerTaskId) || '' : raw.ownerTaskId).trim();
    if (ownerTaskId.length > 120) return { ok: false, error: `items[${i}].ownerTaskId 最多 120 字符`, code: 'ARG_SCHEMA' };
    items.push({ id, step, acceptanceCriteria, status, ...(evidenceCallIds.length ? { evidenceCallIds } : {}), ...(reason ? { reason } : {}), ...(dependsOn.length ? { dependsOn } : {}), ...(ownerTaskId ? { ownerTaskId } : {}) });
  }
  for (const old of previousItems) {
    if (old && old.id && !usedIds.has(String(old.id))) {
      return { ok: false, error: `不能直接删除步骤 ${old.id}；请保留该步骤并设为 cancelled，同时填写 reason`, code: 'ARG_SEMANTIC' };
    }
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    for (const dependency of item.dependsOn || []) {
      const prerequisite = byId.get(dependency);
      if (!prerequisite) return { ok: false, error: `步骤 ${item.id} 依赖不存在的步骤 ID：${dependency}`, code: 'ARG_SEMANTIC' };
      if (dependency === item.id) return { ok: false, error: `步骤 ${item.id} 不能依赖自己`, code: 'ARG_SEMANTIC' };
      if ((item.status === 'in_progress' || item.status === 'completed') && prerequisite.status !== 'completed') {
        return { ok: false, error: `步骤 ${item.id} 不能设为 ${item.status}：前置步骤 ${dependency} 尚未 completed`, code: 'ARG_SEMANTIC' };
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const hasCycle = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const item = byId.get(id);
    for (const dependency of (item && item.dependsOn) || []) if (hasCycle(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const item of items) {
    if (hasCycle(item.id)) return { ok: false, error: `计划依赖关系存在循环（涉及 ${item.id}）`, code: 'ARG_SEMANTIC' };
  }
  if (inProgress > 1) {
    return {
      ok: false,
      error: `同一时刻最多只能有 1 项 in_progress（当前 ${inProgress} 项）：把其余项改成 pending 或 completed 后重试`,
      code: 'ARG_SEMANTIC',
    };
  }
  return { ok: true, items };
}

/** 计划统计（事件/结果/界面共用同一口径） */
function summarizePlan(plan) {
  const items = (plan && Array.isArray(plan.items) ? plan.items : []).filter(Boolean);
  return {
    total: items.length,
    completed: items.filter((i) => i && i.status === 'completed').length,
    inProgress: items.filter((i) => i && i.status === 'in_progress').length,
    pending: items.filter((i) => i && i.status === 'pending').length,
    blocked: items.filter((i) => i && i.status === 'blocked').length,
    cancelled: items.filter((i) => i && i.status === 'cancelled').length,
  };
}

/** 完成或取消的计划只作为历史展示，不自动沿用到新的 run。 */
function isTerminalPlan(plan) {
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  return items.length > 0 && items.every((item) => item && (item.status === 'completed' || item.status === 'cancelled'));
}

/**
 * 渲染成给模型看的文本（工具结果与进度提示共用 —— 两处文案必须同源，否则模型看到两种口径）。
 * @param {{items?: Array<{id?: string, step: string, acceptanceCriteria?: string, status: string, evidenceCallIds?: string[], reason?: string, dependsOn?: string[], ownerTaskId?: string}>}|null} plan
 * @returns {string}
 */
function renderPlan(plan) {
  const items = (plan && Array.isArray(plan.items) ? plan.items : []).filter((i) => i && i.step);
  if (!items.length) return '（当前计划为空）';
  const s = summarizePlan(plan);
  const head = `计划（共 ${s.total} 项：完成 ${s.completed} / 进行中 ${s.inProgress} / 待办 ${s.pending} / 受阻 ${s.blocked} / 已取消 ${s.cancelled}）`;
  return head + '\n' + items.map((i) => {
    const lines = [`${STATUS_MARKS[i.status] || '[ ]'} ${i.id ? '[' + i.id + '] ' : ''}${i.step}`, `  验收：${i.acceptanceCriteria || '（未填写）'}`];
    if (i.status === 'completed' && Array.isArray(i.evidenceCallIds)) lines.push('  证据调用：' + i.evidenceCallIds.join('、'));
    if (Array.isArray(i.dependsOn) && i.dependsOn.length) lines.push('  前置步骤：' + i.dependsOn.join('、'));
    if (i.ownerTaskId) lines.push('  子代理任务：' + i.ownerTaskId);
    if (i.reason) lines.push('  说明：' + i.reason);
    return lines.join('\n');
  }).join('\n');
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && Array.isArray(parsed.items) ? migrateLegacyPlan(parsed) : null;
  } catch { return null; }
}

function migrateLegacyPlan(parsed) {
  let changed = false;
  const items = parsed.items.map((item, index) => {
    const next = { ...item };
    if (!next.id) { next.id = 'step-' + crypto.createHash('sha1').update(String(next.step || index)).digest('hex').slice(0, 10); changed = true; }
    if (!next.acceptanceCriteria) { next.acceptanceCriteria = '核对该步骤的实际结果'; changed = true; }
    if (!Array.isArray(next.evidenceCallIds)) next.evidenceCallIds = [];
    if (next.status === 'completed' && next.evidenceCallIds.length === 0) {
      next.status = 'blocked';
      next.reason = '旧版计划没有关联可核验的工具结果，请复核后再完成';
      changed = true;
    }
    return next;
  });
  return { ...parsed, version: 2, items, migrated: changed || parsed.version !== 2 };
}

/**
 * 读取该 run 的计划（不存在/损坏都返回 null —— 调用方按"没有计划"处理，不抛）。
 * @param {string} projectRoot @param {string} runId
 * @returns {{items: Array<{id: string, step: string, acceptanceCriteria: string, status: string, evidenceCallIds?: string[], reason?: string, dependsOn?: string[], ownerTaskId?: string}>, updatedAt?: string, runId?: string, sessionId?: string}|null}
 */
function readPlan(projectRoot, runId) {
  if (!projectRoot || !runId) return null;
  const saved = readJsonFile(planFile(projectRoot, runId));
  if (saved) return saved;
  // 原子文件不可用时，从 run 事件恢复最后一份已写入的计划。
  try {
    const eventsFile = path.join(path.resolve(projectRoot), '.codenode', 'runs', String(runId).replace(/[^A-Za-z0-9._-]/g, '_') + '.jsonl');
    const events = fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      try {
        const event = JSON.parse(events[i]);
        if ((event.type === 'plan_updated' || event.type === 'plan_inherited') && Array.isArray(event.items)) {
          return migrateLegacyPlan({ runId: String(runId), updatedAt: event.ts, items: event.items });
        }
      } catch { /* 忽略损坏事件行 */ }
    }
  } catch { /* 没有事件文件 */ }
  return null;
}

function readSessionPlan(projectRoot, sessionId) {
  const file = sessionPlanFile(projectRoot, sessionId);
  return file ? readJsonFile(file) : null;
}

/**
 * 原子写入计划（目录不存在时自动建）。
 * @param {string} projectRoot @param {string} runId
 * @param {Array<{id?: string, step: string, acceptanceCriteria?: string, status: string, evidenceCallIds?: string[], reason?: string, dependsOn?: string[], ownerTaskId?: string}>} items
 * @param {{updatedAt?: string, sessionId?: string}} [meta]
 * @returns {string|null} 实际写入的文件路径；无 runId / 写失败返回 null
 */
function writePlan(projectRoot, runId, items, meta) {
  if (!projectRoot || !runId) return null;
  try {
    const file = planFile(projectRoot, runId);
    const payload = {
      version: 2,
      runId: String(runId),
      sessionId: meta && meta.sessionId ? String(meta.sessionId) : null,
      updatedAt: (meta && meta.updatedAt) || new Date().toISOString(),
      items: (Array.isArray(items) ? items : []).map((item) => ({ ...item })),
    };
    atomicWriteFile(file, JSON.stringify(payload, null, 2));
    return file;
  } catch {
    return null;
  }
}

function writeSessionPlan(projectRoot, sessionId, runId, items, meta) {
  const file = sessionPlanFile(projectRoot, sessionId);
  if (!file) return null;
  try {
    const payload = {
      version: 2,
      sessionId: String(sessionId),
      runId: String(runId || ''),
      updatedAt: (meta && meta.updatedAt) || new Date().toISOString(),
      items: (Array.isArray(items) ? items : []).map((item) => ({ ...item })),
    };
    atomicWriteFile(file, JSON.stringify(payload, null, 2));
    return file;
  } catch { return null; }
}

module.exports = {
  MAX_PLAN_ITEMS,
  MAX_STEP_CHARS,
  MAX_STEP_ID_CHARS,
  MAX_ACCEPTANCE_CHARS,
  MAX_REASON_CHARS,
  MAX_EVIDENCE_CALLS,
  MAX_DEPENDENCIES,
  PLAN_STATUSES,
  STATUS_MARKS,
  planFile,
  sessionPlanFile,
  normalizePlan,
  summarizePlan,
  isTerminalPlan,
  renderPlan,
  readPlan,
  readSessionPlan,
  writePlan,
  writeSessionPlan,
};
