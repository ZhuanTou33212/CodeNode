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
const { atomicWriteFile } = require('./atomicFile.cjs');

/** 单份计划最多多少项（与 schema 的 maxItems 保持一致） */
const MAX_PLAN_ITEMS = 20;
/** 单个步骤最多多少字符（与 schema 的 maxLength 保持一致） */
const MAX_STEP_CHARS = 200;
/** 合法状态 */
const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'completed']);
/** 状态 → 渲染标记 */
const STATUS_MARKS = Object.freeze({ pending: '[ ]', in_progress: '[→]', completed: '[x]' });

/** `.codenode/runs/<runId>.plan.json`（runId 与 subagents 视图同口径做安全化） */
function planFile(projectRoot, runId) {
  const safe = String(runId || 'unscoped').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs', safe + '.plan.json');
}

/**
 * 校验并归一化 items（不落盘、不依赖上下文，纯函数）。
 * 失败分支带 error + code（供工具直接回给模型，让它改参数重试）。
 * @param {any} rawItems
 * @returns {{ok: boolean, items?: Array<{step: string, status: string}>, error?: string, code?: string}}
 */
function normalizePlan(rawItems) {
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
    const status = String(raw.status == null ? '' : raw.status).trim();
    if (!PLAN_STATUSES.includes(status)) {
      return { ok: false, error: `items[${i}].status 必须是 ${PLAN_STATUSES.join('|')} 之一`, code: 'ARG_SCHEMA' };
    }
    if (status === 'in_progress') inProgress += 1;
    items.push({ step, status });
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
  };
}

/**
 * 渲染成给模型看的文本（工具结果与进度提示共用 —— 两处文案必须同源，否则模型看到两种口径）。
 * @param {{items?: Array<{step: string, status: string}>}|null} plan
 * @returns {string}
 */
function renderPlan(plan) {
  const items = (plan && Array.isArray(plan.items) ? plan.items : []).filter((i) => i && i.step);
  if (!items.length) return '（当前计划为空）';
  const s = summarizePlan(plan);
  const head = `计划（共 ${s.total} 项：完成 ${s.completed} / 进行中 ${s.inProgress} / 待办 ${s.pending}）`;
  return head + '\n' + items.map((i) => `${STATUS_MARKS[i.status] || '[ ]'} ${i.step}`).join('\n');
}

/**
 * 读取该 run 的计划（不存在/损坏都返回 null —— 调用方按"没有计划"处理，不抛）。
 * @param {string} projectRoot @param {string} runId
 * @returns {{items: Array<{step: string, status: string}>, updatedAt?: string, runId?: string}|null}
 */
function readPlan(projectRoot, runId) {
  if (!projectRoot || !runId) return null;
  try {
    const file = planFile(projectRoot, runId);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    // 坏文件当"没有计划"：不让它挡住主循环（与 subagents 视图同一口径）
    return null;
  }
}

/**
 * 原子写入计划（目录不存在时自动建）。
 * @param {string} projectRoot @param {string} runId
 * @param {Array<{step: string, status: string}>} items
 * @param {{updatedAt?: string}} [meta]
 * @returns {string|null} 实际写入的文件路径；无 runId / 写失败返回 null
 */
function writePlan(projectRoot, runId, items, meta) {
  if (!projectRoot || !runId) return null;
  try {
    const file = planFile(projectRoot, runId);
    const payload = {
      runId: String(runId),
      updatedAt: (meta && meta.updatedAt) || new Date().toISOString(),
      items: (Array.isArray(items) ? items : []).map((i) => ({ step: String(i.step), status: String(i.status) })),
    };
    atomicWriteFile(file, JSON.stringify(payload, null, 2));
    return file;
  } catch {
    return null;
  }
}

module.exports = {
  MAX_PLAN_ITEMS,
  MAX_STEP_CHARS,
  PLAN_STATUSES,
  STATUS_MARKS,
  planFile,
  normalizePlan,
  summarizePlan,
  renderPlan,
  readPlan,
  writePlan,
};
