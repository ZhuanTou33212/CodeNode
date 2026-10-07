/**
 * subagents.cjs —— 子代理（delegate_task / delegate_tasks）管理器
 *
 * S9（2026-09-16）收口了五件事，读代码时别再按旧行为推理：
 *   1. **角色契约单一来源**：只读判定 / 工具白名单 / 角色提示全部来自 `tools/roles.cjs`
 *      （此前三处各写一份，实测 `canvas` 有工具却没有角色提示，enum 还对模型暴露它）。
 *   2. **独立预算（父子链）**：每个子代理拿到自己的配额（`agent.subagent.max_total_tokens`），
 *      通过 parent 链把真实用量记回父 run —— 一个子代理超额只让它自己失败，不拖垮父与其他子代理，
 *      同时不绕过 `agent.max_total_tokens` 的 run 总量。
 *   3. **总时长预算**：`timeoutSeconds` 现在是**任务总时长**（默认 600s，可配），用组合信号 +
 *      定时器中止；此前它被当成 runAgentChat 的「单轮超时」（默认 180s × 最多 12 轮）。
 *   4. **结果合并契约**：回灌主上下文的结果带固定字段头（taskId/role/status/工具调用数/变更文件）、
 *      按 `agent.subagent.result_max_chars` 截断并指向 `get_subagent_task`；结构字段放进 data。
 *      失败时显式提示「不要原样重试」，避免主循环的「失败请重试」诱导重复委派。
 *   5. **画布痕迹不再静默丢**：stage 回写前校验节点存在与类型，回写失败写审计与 task.stageWarning。
 *
 * 幂等归因：子代理与父代理共享同一个 side-effect 账本（**刻意如此**：续跑时「已提交就跳过」
 * 的语义必须跨角色成立），但每次登记都带 actor（taskId/role），去重文案说清是谁提交的 —— 见 sideEffects.cjs。
 */
'use strict';

const { AgentToolResult } = require('./tools/result.cjs');
const { ConfirmationLevel } = require('./tools/context.cjs');
const { parseWebSearchConfig } = require('./tools/impl/webSearchTool.cjs');
const worktreeLib = require('./worktree.cjs');
const { LeaseRegistry } = require('./tools/leases.cjs');
const { changedFilesFromToolCalls } = require('./tools/fileChanges.cjs');
// 确定性合并 + 冲突裁决（P5）：合并结果只依赖贡献项自身，不依赖到达顺序
const mergeLib = require('./tools/merge.cjs');
// 子代理结果的**单一 JSON 信封**（多 Agent 信息完整性 P1/P2）：契约校验 + 产物哈希 + 有损自报
const subagentEnvelope = require('./subagentEnvelope.cjs');
const roles = require('./tools/roles.cjs');
const subagentPrompt = require('./subagentPrompt.cjs');
const { createSubagentBudget } = require('./requestBudget.cjs');
const fs = require('fs');
const { randomUUID } = require('crypto');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { SubagentScheduler, transitionTask } = require('./subagentScheduler.cjs');
const schedulingSettings = require('./schedulingSettings.cjs');
const schedulingUi = require('../config/ui.scheduling.json');

/**
 * 子代理任务视图的**持久化**（§4.2 的第一件事）。
 *
 * 缺口：`this.tasks` 只是**进程内**的 Map —— 请求一结束、界面一刷新，子代理干过什么就只剩下
 * 事件流里的两行 delta；「这次到底派了谁、做到哪一步、结论是什么」没有任何可查的地方，
 * 跨 run 更查不到（重启即失忆）。
 *
 * 落盘口径：`.codenode/runs/<runId>.subagents.json`，每条任务一行视图（按 taskId 合并更新）。
 * 结果信封、父代理的确认记录与依赖关系必须一起落盘，恢复时才不会把候选结果误当成已确认内容。
 */
const MAX_PERSISTED_TASKS = 50;
const MAX_PERSISTED_TASK_SUMMARY_CHARS = 200000;
const MODEL_TASK_SUMMARY_CHARS = 600;
const FULL_TASK_SUMMARY_PAGE_CHARS = 12000;
const MODEL_BATCH_RESULT_CHARS = 16000;

/** @param {any} projectRoot @param {any} runId */
function subagentViewFile(projectRoot, runId) {
  const safe = String(runId || 'unscoped').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs', safe + '.subagents.json');
}

/**
 * 落盘一条任务视图（同一 taskId 覆盖更新；按 taskId 去重，不会因复用 id 而膨胀）。
 * @param {any} projectRoot @param {any} runId @param {any} view
 */
function persistTaskView(projectRoot, runId, view, options = {}) {
  if (!projectRoot || !view || !view.taskId) return null;
  const file = subagentViewFile(projectRoot, runId);
  const rawSummary = typeof view.summary === 'string' ? view.summary : '';
  const envelopeSummary = String((view.envelope && view.envelope.payload && view.envelope.payload.summary) || '');
  const summaryInEnvelope = !!rawSummary && rawSummary === envelopeSummary;
  /** @type {any[]} */
  let list = [];
  let startedTaskCount = 0;
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed.tasks)) throw new Error('任务视图格式无效');
      if (parsed.startedTaskCount != null && (!Number.isInteger(parsed.startedTaskCount) || parsed.startedTaskCount < 0)) throw new Error('任务配额格式无效');
      list = parsed.tasks;
      startedTaskCount = Math.max(Number(parsed.startedTaskCount) || 0, list.filter(item => item?.startedAt).length);
    }
  } catch (error) {
    throw new Error('任务视图不可读，拒绝覆盖：' + String(error.message || error));
  }
  const record = {
    lifecycleVersion: 2,
    executionId: view.executionId || null,
    taskId: view.taskId,
    runId: view.runId || runId || null,
    role: view.role || null,
    objective: view.objective || '',
    acceptanceCriteria: Array.isArray(view.acceptanceCriteria) ? view.acceptanceCriteria.map(String) : [],
    stageNodeId: view.stageNodeId || null,
    status: view.status || null,
    summary: rawSummary.slice(0, MAX_PERSISTED_TASK_SUMMARY_CHARS),
    summaryChars: rawSummary.length,
    summaryInEnvelope,
    summaryStorageDroppedChars: Math.max(0, rawSummary.length - MAX_PERSISTED_TASK_SUMMARY_CHARS),
    error: view.error || null,
    usage: view.usage || null,
    toolCalls: Array.isArray(view.toolCalls) ? view.toolCalls.length : undefined,
    startedAt: view.startedAt || null,
    finishedAt: view.finishedAt || null,
    queuedAt: view.queuedAt || null,
    deadline: view.deadline || null,
    executionSettled: view.executionSettled === true,
    requiresReview: view.requiresReview === true,
    cancelReason: view.cancelReason || null,
    outcomeReason: view.outcomeReason || null,
    version: Number(view.version) || 0,
    artifactRoot: view.artifactRoot || null,
    verifiesTaskId: view.verifiesTaskId || null,
    verificationCandidateDigest: view.verificationCandidateDigest || null,
    envelope: view.envelope || null,
    review: view.review || null,
    dependsOnTaskIds: Array.isArray(view.dependsOnTaskIds) ? [...new Set(view.dependsOnTaskIds.map(String))] : [],
    worktree: view.worktree || null,
  };
  const index = list.findIndex((item) => item && item.taskId === record.taskId);
  // Count before retention, independently of the number of task views kept.
  if (record.startedAt && (index < 0 || !list[index].startedAt)) startedTaskCount++;
  if (index >= 0) list[index] = { ...list[index], ...record };
  else list.push(record);
  const requestedLimit = Number(options.maxTasks);
  const retentionLimit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(100, requestedLimit) : MAX_PERSISTED_TASKS;
  const protectedItems = list.filter((item) => ['queued', 'running', 'cancelling'].includes(item.status) || item.requiresReview);
  const settled = list.filter((item) => !protectedItems.includes(item));
  const settledSlots = Math.max(0, retentionLimit - protectedItems.length);
  list = [...protectedItems, ...(settledSlots ? settled.slice(-settledSlots) : [])];
  atomicWriteFile(file, JSON.stringify({ runId: String(runId || ''), updatedAt: new Date().toISOString(), startedTaskCount, tasks: list }, null, 2));
  return record;
}

/**
 * 读某个 run 的落盘任务视图（跨进程/跨会话可查）。
 * @param {any} projectRoot @param {any} runId
 */
function readTaskViews(projectRoot, runId) {
  const file = subagentViewFile(projectRoot, runId);
  try {
    if (!fs.existsSync(file)) return { ok: true, runId: String(runId || ''), updatedAt: null, startedTaskCount: 0, tasks: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed.tasks) || parsed.tasks.some((item) => !item || !item.taskId || !['queued', 'running', 'cancelling', 'done', 'failed', 'blocked', 'cancelled'].includes(item.status))) throw new Error('任务视图格式无效');
    if (parsed.startedTaskCount != null && (!Number.isInteger(parsed.startedTaskCount) || parsed.startedTaskCount < 0)) throw new Error('任务配额格式无效');
    return { ok: true, runId: String(runId || ''), updatedAt: parsed.updatedAt || null,
      startedTaskCount: Math.max(Number(parsed.startedTaskCount) || 0, parsed.tasks.filter(item => item?.startedAt).length), tasks: parsed.tasks };
  } catch (error) {
    return { ok: false, runId: String(runId || ''), updatedAt: null, tasks: [], error: '任务视图损坏：' + String((error && error.message) || error) };
  }
}

/**
 * 列出最近的若干个 run 的子代理任务视图（界面用；按 updatedAt 倒序）。
 * @param {any} projectRoot @param {{maxRuns?: number, maxTasksPerRun?: number}} [options]
 */
function listTaskViews(projectRoot, options = {}) {
  const dir = path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs');
  const maxRuns = Number(options.maxRuns) > 0 ? Number(options.maxRuns) : 5;
  const maxTasks = Number(options.maxTasksPerRun) > 0 ? Number(options.maxTasksPerRun) : 20;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.subagents.json'));
  } catch {
    return { ok: true, runs: [] };
  }
  const runs = [];
  for (const name of files) {
    const runId = name.replace(/\.subagents\.json$/, '');
    const view = readTaskViews(projectRoot, runId);
    if (!view.tasks.length) continue;
    runs.push({
      runId,
      updatedAt: view.updatedAt,
      ok: view.ok,
      error: view.error || null,
      tasks: view.tasks.slice(-maxTasks).map((task) => {
        const envelope = task && task.envelope;
        const { envelope: _envelope, artifactRoot: _artifactRoot, ...summary } = task || {};
        const displaySummary = String(summary.summary || (envelope && envelope.payload && envelope.payload.summary) || '');
        return {
          ...summary,
          summary: displaySummary.slice(0, 2000),
          summaryChars: Number(summary.summaryChars) || displaySummary.length,
          hasEnvelope: !!envelope,
          sourceMsgId: envelope && envelope.msgId || null,
        };
      }),
    });
  }
  runs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { ok: true, runs: runs.slice(0, maxRuns) };
}

/** 只读角色（来自角色契约，不再各留一份名单） */
const READ_ONLY_ROLES = new Set(roles.ROLE_NAMES.filter((name) => roles.isReadOnlyRole(name)));

function parallelSafeTask(item) {
  const task = item || {};
  const role = String(task.role || '');
  const isolatedFiles = String(task.isolation || 'none').trim() === 'worktree' && role !== 'canvas' && !task.verifiesTaskId;
  if (isolatedFiles) return true;
  const definition = roles.roleDefinition(role);
  const runsCommands = !!(definition && definition.tools.some((tool) => tool === 'execute_shell' || tool === 'poll_job'));
  return READ_ONLY_ROLES.has(role) && !runsCommands;
}

/** 角色提示（保留旧导出：外部/测试按名字取提示） */
const ROLE_PROMPTS = Object.freeze(
  Object.fromEntries(roles.ROLE_NAMES.map((name) => [name, roles.rolePrompt(name)])),
);

/**
 * 子代理默认值。
 * 注意：`@type` 里的键类型必须显式写出，否则 `Object.freeze` 会把 `leases: true` 收窄成字面量
 * `true`、`leaseTtlMs` 收窄成 `120000`，随后 `this.subCfg.leases !== false` 会被 tsc 判成
 * 「number 与 boolean 不可能重叠」（checkJs 实测）。
 * @type {{maxTasksPerRun: number, maxBatchTasks: number, maxConcurrentTasks: number, totalTimeoutSeconds: number,
 *         resultMaxChars: number, leases: boolean, leaseTtlMs: number, warningPercent: number}}
 */
const DEFAULTS = Object.freeze({
  maxTasksPerRun: schedulingUi.defaults.maxTasksPerRun,
  maxBatchTasks: schedulingUi.defaults.maxBatchTasks,
  maxConcurrentTasks: schedulingUi.defaults.concurrency,
  warningPercent: schedulingUi.defaults.warningPercent,
  totalTimeoutSeconds: 600,
  resultMaxChars: 8000,
  /** 跨 Agent 资源租约（P3）：默认开 */
  leases: true,
  leaseTtlMs: 120000,
});

/** 单轮模型调用超时上限（子代理总时长再长，单轮也不该无限等） */
const MAX_SINGLE_TURN_TIMEOUT_MS = 180000;
const MIN_TOTAL_TIMEOUT_MS = 10000;
const MAX_TOTAL_TIMEOUT_MS = 3600000;

function makeTaskId() {
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** 按输入顺序保存结果；单个子任务异常不会提前放走仍在运行的兄弟任务。 */
async function runBatchTasks(tasks, concurrency, work) {
  /** @type {any[]} */
  const results = new Array(tasks.length);
  const workers = Math.min(tasks.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = await work(tasks[index]);
      } catch (error) {
        results[index] = AgentToolResult.error('子代理内部异常：' + String((error && error.message) || error).slice(0, 300), {
          taskId: tasks[index].taskId,
          status: 'failed',
        });
      }
    }
  }));
  return results;
}

/**
 * 子代理任务总时长（秒 → 毫秒）。缺省取配置值，钳到 [10s, 1h]。
 * @param {any} seconds 模型传入的 timeoutSeconds
 * @param {number} fallbackSeconds 配置里的默认总时长
 * @returns {number}
 */
function clampTotalTimeout(seconds, fallbackSeconds) {
  const fallback =
    Number.isFinite(Number(fallbackSeconds)) && Number(fallbackSeconds) > 0
      ? Number(fallbackSeconds)
      : DEFAULTS.totalTimeoutSeconds;
  const n = Number(seconds);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(MIN_TOTAL_TIMEOUT_MS, Math.min(MAX_TOTAL_TIMEOUT_MS, Math.floor(base * 1000)));
}

/**
 * 默认的项目 Skill 读取：与主代理**同一个来源**（`.codenode/extensions.json` 或
 * `config/extensions.json` 里 kind=skills 的条目），此前子代理完全看不到它们。
 * 延迟 require extensions.cjs —— 它连带 sandbox / context 等重量级依赖，构造路径上不需要。
 * @param {string|null} projectRoot
 */
function defaultProjectSkills(projectRoot) {
  if (!projectRoot) return [];
  try {
    return require('./tools/extensions.cjs')
      .readManifest(projectRoot)
      .filter((item) => String(item.kind || '').toLowerCase() === 'skills')
      .map((item) => ({ name: String(item.name), instructions: String(item.instructions || item.description || '') }));
  } catch {
    return [];
  }
}

/** 从工具调用记录里提取被改动的文件（best-effort，解析不出就跳过，绝不猜） */
/**
 * 「已改动文件」的唯一口径在 tools/fileChanges.cjs —— 主循环的进度检查层用的是同一份实现。
 * 这里保留同名薄封装，避免两处各写一份（此前本文件那份还会漏掉 bulk_edit 的 edits[] 路径）。
 */
function changedFiles(toolCalls) {
  return changedFilesFromToolCalls(toolCalls);
}

/**
 * 对外的任务视图（也会作为 AgentToolResult.data 回给主代理）。
 * `envelope` = 该任务完成时**一次性**建好的单一 JSON 信封（见 electron/subagentEnvelope.cjs）：
 * 哈希/产物是那一刻的真实值，之后的查询只做回放，不重算（重算会让哈希随世界变化而变化，
 * 反而毁掉「判断报告之后世界是否又变过」的用途）。
 */
/**
 * 隔离工作树的结果段落：路径 / 分支 / 改动 / 提交 / 下一步怎么合并或丢弃。
 * 必须写明「这些改动不在主工作树里」——否则主代理会以为改动已经在主工作树里了。
 */
function renderWorktreeSummary(info) {
  return [
    '【隔离工作树】' + (info.relativePath || info.path) + '（分支 ' + (info.branch || '-') + '，基线 ' + (info.base || '-') + '）',
    '- 改动：' + (info.changed && info.changed.length ? info.changed.join('、') : '无未提交改动'),
    '- 新提交：' + (info.commits || 0) + ' 个',
    '- 这些改动**不在**主工作树里；核验后调用 review_subagent_result(decision="confirm_and_merge")，由系统先预检并合入、再确认摘要。取消或冲突时保留隔离工作树供复核；核验完成前不要移除。',
  ].join('\n');
}

function taskView(task) {
  return {
    executionId: task.executionId || null,
    taskId: task.taskId,
    runId: task.runId,
    role: task.role,
    objective: task.objective,
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.slice() : [],
    stageNodeId: task.stageNodeId,
    status: task.status,
    summary: task.summary || '',
    summaryChars: Number(task.summaryChars) || String(task.summary || '').length,
    summaryStorageDroppedChars: Math.max(Number(task.summaryStorageDroppedChars) || 0,
      Math.max(0, String(task.summary || '').length - MAX_PERSISTED_TASK_SUMMARY_CHARS)),
    error: task.error || null,
    grounding: task.grounding || null,
    usage: task.usage || null,
    stageWarning: task.stageWarning || null,
    envelope: task.envelope || null,
    review: task.review || null,
    dependsOnTaskIds: Array.isArray(task.dependsOnTaskIds) ? task.dependsOnTaskIds.slice() : [],
    artifactRoot: task.artifactRoot || null,
    verifiesTaskId: task.verifiesTaskId || null,
    verificationCandidateDigest: task.verificationCandidateDigest || null,
    // 隔离工作树信息（有则给出路径/分支/改动，供主代理决定合并或移除）
    worktree: task.worktree || null,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt || null,
    queuedAt: task.queuedAt || null,
    deadline: task.deadline || null,
    executionSettled: task.executionSettled === true,
    requiresReview: task.requiresReview === true,
    cancelReason: task.cancelReason || null,
    outcomeReason: task.outcomeReason || null,
    version: Number(task.version) || 0,
  };
}

/** 默认给父 Agent 的候选卡：短摘要 + 来源/产物/真实命令状态。完整结论留在本地按需展开。 */
function renderTaskModelCard(view, options = {}) {
  const task = view || {};
  const compact = options.compact === true;
  const summaryLimit = compact ? 220 : MODEL_TASK_SUMMARY_CHARS;
  const fileLimit = compact ? 3 : 8;
  const sourceLimit = compact ? 3 : 8;
  const commandLimit = compact ? 1 : 3;
  const envelope = task.envelope || {};
  const payload = envelope.payload || {};
  const summary = String(task.summary || payload.summary || task.error || '');
  const evidence = envelope.evidence || {};
  const grounding = task.grounding || payload.grounding || {};
  const commands = Array.isArray(evidence.commands) ? evidence.commands : [];
  const files = Array.isArray(evidence.files) ? evidence.files : [];
  const card = {
    taskId: task.taskId || null,
    role: task.role || null,
    status: task.status || null,
    verifiesTaskId: task.verifiesTaskId || null,
    verificationCandidateDigest: task.verificationCandidateDigest || null,
    reviewStatus: task.review && task.review.status || (envelope.kind === 'result' ? 'candidate' : 'not_eligible'),
    summary: summary.slice(0, summaryLimit),
    summaryChars: Number(task.summaryChars || payload.summaryChars) || summary.length,
    summaryTruncated: summary.length > summaryLimit ||
      !!(envelope.lossy && envelope.lossy.isLossy) || Number(task.summaryStorageDroppedChars) > 0,
    summaryStorageDroppedChars: Number(task.summaryStorageDroppedChars) || 0,
    source: envelope.msgId ? {
      runId: envelope.from && envelope.from.runId || task.runId || null,
      msgId: envelope.msgId,
      snapshot: envelope.snapshot || null,
      trust: envelope.trust || null,
    } : null,
    ...(task.verification ? { verification: {
      verdict: task.verification.verdict,
      checkedAt: task.verification.checkedAt,
      snapshot: task.verification.snapshot || null,
      files: (task.verification.files || []).slice(0, fileLimit).map((file) => ({
        path: file.path, ok: file.ok, expected: file.declared || null, actual: file.actual || null,
      })),
      sources: (task.verification.sources || []).slice(0, sourceLimit).map((source) => ({
        path: source.path, ok: source.ok, versioned: source.versioned, checkedBy: source.checkedBy,
        ranges: (source.ranges || []).slice(0, compact ? 1 : 4),
      })),
      reasons: (task.verification.reasons || []).slice(0, 4),
    } } : {}),
    changedFiles: (Array.isArray(envelope.refs) ? envelope.refs : []).map((ref) => ref.path).filter(Boolean).slice(0, fileLimit),
    changedFilesOmitted: Math.max(0, (Array.isArray(envelope.refs) ? envelope.refs.length : 0) - fileLimit),
    evidence: {
      files: files.slice(0, fileLimit).map((file) => ({ path: file.path, exists: file.exists, bytes: file.bytes, sha256: file.sha256 })),
      filesOmitted: Math.max(0, files.length - fileLimit),
      sources: (Array.isArray(evidence.sources) ? evidence.sources : []).slice(0, sourceLimit).map((source) => ({
        path: source.path, sha256: source.sha256, versioned: source.versioned,
        ranges: (source.ranges || []).slice(0, compact ? 1 : 4), citations: (source.citations || []).slice(0, compact ? 1 : 4),
      })),
      sourcesOmitted: Math.max(0, (Array.isArray(evidence.sources) ? evidence.sources.length : 0) - sourceLimit),
      commands: commands.slice(0, commandLimit).map((command) => ({
        cmd: String(command.cmd || '').slice(0, compact ? 100 : 180),
        exitCode: command.exitCode == null ? null : command.exitCode,
        ok: command.ok == null ? null : command.ok,
        passed: command.passed == null ? null : command.passed,
        status: command.status || null,
        outputSummary: String(command.outputSummary || '').slice(-(compact ? 80 : 160)),
      })),
      commandsOmitted: Math.max(0, commands.length - commandLimit),
      warnings: (Array.isArray(evidence.warnings) ? evidence.warnings : []).slice(0, compact ? 1 : 3),
    },
    ...(grounding && Object.keys(grounding).length ? { grounding: {
      status: grounding.status || null,
      valid: grounding.valid == null ? null : grounding.valid,
      citations: (Array.isArray(grounding.used) ? grounding.used : []).slice(0, compact ? 3 : 8),
      invalid: (Array.isArray(grounding.invalid) ? grounding.invalid : []).slice(0, 4),
    } } : {}),
    ...(task.review && task.review.status === 'confirmed'
      ? {
        confirmedSummary: String(task.review.confirmedSummary || '').slice(0, compact ? 160 : 400),
        reviewedAt: task.review.reviewedAt,
        verificationLevel: task.review.source && task.review.source.verifier ? 'independent' : 'parent_review',
        validationBasis: task.review.source && task.review.source.validationBasis || 'all',
        verifierTaskId: task.review.source && task.review.source.verifier && task.review.source.verifier.taskId || null,
      }
      : {}),
    ...(task.error ? { error: String(task.error).slice(0, 600) } : {}),
    ...(Array.isArray(envelope.lossy && envelope.lossy.contractViolations) && envelope.lossy.contractViolations.length
      ? { contractViolations: envelope.lossy.contractViolations.slice(0, 6) } : {}),
    ...(task.worktree ? { worktree: {
      branch: task.worktree.branch || null,
      changed: (task.worktree.changed || []).slice(0, compact ? 3 : 8),
      commits: task.worktree.commits || 0,
      notMerged: true,
      reviewBeforeMerge: true,
    } } : {}),
    fullResultRef: 'get_subagent_task(taskId="' + String(task.taskId || '') + '", detail="full")',
  };
  return '[子代理候选卡]\n' + JSON.stringify(card);
}

/** 返回一个有明确游标的摘要页，避免一次展开再次撑满父 Agent 上下文。 */
function renderTaskFullPage(view, offset, pageChars) {
  const task = view || {};
  const full = String(task.summary || '');
  const totalChars = Number(task.summaryChars) || full.length;
  const start = Math.max(0, Math.min(full.length, Math.floor(Number(offset) || 0)));
  const size = Math.max(500, Math.min(FULL_TASK_SUMMARY_PAGE_CHARS, Math.floor(Number(pageChars) || FULL_TASK_SUMMARY_PAGE_CHARS)));
  const end = Math.min(full.length, start + size);
  const page = {
    ...task,
    summary: full.slice(start, end),
    summaryChars: totalChars,
    summaryStoredChars: full.length,
    summaryOffset: start,
    summaryNextOffset: end < full.length ? end : null,
    summaryIncomplete: Number(task.summaryStorageDroppedChars) > 0,
    summaryStorageDroppedChars: Number(task.summaryStorageDroppedChars) || 0,
  };
  if (page.envelope && page.envelope.payload) {
    page.envelope = { ...page.envelope, payload: { ...page.envelope.payload, summary: '（完整摘要见 summary 页）' } };
  }
  return JSON.stringify(page);
}

/** 合并默认只展示摘要和少量可行动项；完整明细仍可按需读取。 */
function renderMergeModelCard(merged, maxItems = 8) {
  const m = merged || { digest: '', counts: {}, resources: [] };
  const counts = m.counts || {};
  const actionable = (Array.isArray(m.resources) ? m.resources : []).filter((item) => item.status !== 'agreed');
  const lines = [
    '[候选合并摘要；尚未成为共享事实]',
    'digest=' + String(m.digest || '') + ' resources=' + (counts.resources || 0) +
      ' agreed=' + (counts.agreed || 0) + ' superseded=' + (counts.superseded || 0) +
      ' arbitrated=' + (counts.arbitrated || 0) + ' conflicts=' + (counts.conflicts || 0),
  ];
  for (const item of actionable.slice(0, maxItems)) {
    const sources = (item.contributions || []).map((source) =>
      String(source.actor || '?') + '[' + String(source.source || '?') + ']'
    ).join(', ');
    lines.push('- ' + item.status + ' ' + item.resourceKey +
      (item.value == null ? '' : ' => ' + String(item.value).slice(0, 120)) +
      (sources ? ' (' + sources + ')' : ''));
  }
  if (actionable.length > maxItems) {
    lines.push('…另有 ' + (actionable.length - maxItems) + ' 个可行动项；需要时用 merge_subagent_results(detail="full") 展开。');
  }
  if (Array.isArray(m.rejectedDecisions) && m.rejectedDecisions.length) {
    lines.push('rejectedDecisions=' + m.rejectedDecisions.length);
  }
  return lines.join('\n');
}

function renderBatchModelContent(results, merged) {
  const list = Array.isArray(results) ? results : [];
  const mergeCard = renderMergeModelCard(merged, 4);
  const bodyBudget = Math.max(2000, MODEL_BATCH_RESULT_CHARS - mergeCard.length - 800);
  const cards = [];
  const omitted = [];
  let used = 0;
  for (const result of list) {
    const view = (result && result.data) || {};
    const card = renderTaskModelCard(view, { compact: true }) + (result && result.ok === false ? '\nresultOk=false' : '');
    if (!cards.length || used + card.length + 2 <= bodyBudget) {
      cards.push(card);
      used += card.length + 2;
    } else {
      omitted.push(String(view.taskId || '?') + (result && result.ok === false ? '(failed)' : ''));
    }
  }
  const lines = ['[批量子任务摘要；每项默认候选]'];
  if (cards.length) lines.push(cards.join('\n\n'));
  if (omitted.length) lines.push('未在本次上下文展开：' + omitted.join(', ') + '；需要时按 taskId 调用 get_subagent_task。');
  lines.push(mergeCard);
  const content = lines.join('\n\n');
  return content.length <= MODEL_BATCH_RESULT_CHARS
    ? content
    : content.slice(0, MODEL_BATCH_RESULT_CHARS - 80) + '\n…摘要已截短；taskId/data 仍保留，可按需读取。';
}

class SubagentManager {
  constructor(options) {
    const o = options || {};
    this.agent = o.agent;
    this.toolkit = o.toolkit;
    this.cfg = o.cfg || {};
    this.registry = o.registry;
    this.runId = o.runId || 'run-' + Date.now().toString(36);
    this.onDelta = o.onDelta || null;
    /** 读项目自定义 Skill（kind=skills 的扩展）；可注入，便于用例离线验证 */
    this.readProjectSkills = typeof o.readProjectSkills === 'function' ? o.readProjectSkills : defaultProjectSkills;
    this.tasks = new Map();
    this.taskViewsHydrated = false;
    /**
     * 本 run **曾进入 running** 的子代理任务数（#18 配额计数）。
     *
     * 刻意不用 `this.tasks.size` 当配额：`tasks` 是「taskId → 任务视图」的 Map，
     * 模型只要复用同一个 `taskId`（例如每轮都写 "task-1"），Map 大小就恒为 1，
     * `maxTasksPerRun` 永不触发 —— 单 run 的子代理数量与花费失去上界。
     * 计数器只加不减，与 taskId 是否复用、任务视图是否被覆盖/清理都无关。
     * @type {number}
     */
    this.startedTaskCount = 0;
    /** @type {Record<string, number>} 子代理配置（agent.subagent.*），缺项用默认值 */
    this.subCfg = Object.assign({}, DEFAULTS, (o.cfg && o.cfg.subagent) || {});
    this.scheduler = new SubagentScheduler(this.subCfg.maxConcurrentTasks);
    // The supervisor reads live consumption before each model request; children
    // must not inherit this supervisor-only convergence instruction.
    this.cfg.subagentBudgetState = context => {
      if (context) {
        const hydrated = this.hydrateTasks(context);
        if (!hydrated.ok) throw new Error(hydrated.error || '子任务配额无法恢复');
      }
      return schedulingSettings.budgetState(this.startedTaskCount, this.subCfg.maxTasksPerRun, this.subCfg.warningPercent);
    };
    this.reservations = new Map();
    /**
     * 跨 Agent 资源租约：**必须与主代理共享同一个实例**（由 ipc 按 run 建好传进来），
     * 否则每个子代理各有一份注册表 = 谁也没锁住谁。没传进来时自己建一个（单测/独立使用场景）。
     */
    this.leases =
      o.leases ||
      new LeaseRegistry({
        // String() 兜一层：subCfg 的类型来自多处 Object.assign 的交集，字面量比较会被 tsc 判成
        // 「number 与 boolean 不可能重叠」（checkJs 实测），而这只是配置读值
        enabled: String(this.subCfg.leases) !== 'false',
        ttlMs: Number(this.subCfg.leaseTtlMs) || 120000,
      });
  }

  /** 只读验证计划步骤引用的子代理 taskId 属于本次 run。 */
  hasTask(taskId) {
    return this.tasks.has(String(taskId || '')) || this.reservations.has(String(taskId || ''));
  }

  /**
   * 恢复本 run 已完成的子任务。Run 检查点恢复时，进程内 Map 会重建；信封和父代理审查态来自
   * 同一个原子任务视图文件，避免只恢复「成功」文本而丢掉候选/确认边界。
   */
  hydrateTasks(context) {
    if (this.taskViewsHydrated) return { ok: true, tasks: this.tasks.size };
    const root = typeof context.projectRoot === 'function' ? context.projectRoot() : '';
    const stored = readTaskViews(root, this.runId);
    if (!stored.ok) return stored;
    for (const record of stored.tasks) {
      if (!record || !record.taskId || this.tasks.has(String(record.taskId))) continue;
      const envelope = record.envelope || null;
      this.tasks.set(String(record.taskId), {
        ...record,
        taskId: String(record.taskId),
        runId: record.runId || this.runId,
        summary: String(record.summary || (envelope && envelope.payload && envelope.payload.summary) || ''),
        summaryStorageDroppedChars: Number(record.summaryStorageDroppedChars) || 0,
        error: String(record.error || ''),
        envelope,
        review: record.review || { status: envelope && envelope.kind === 'result' ? 'candidate' : 'not_eligible' },
        dependsOnTaskIds: Array.isArray(record.dependsOnTaskIds) ? [...new Set(record.dependsOnTaskIds.map(String))] : [],
        artifactRoot: record.artifactRoot || root,
        toolCalls: [],
        recovered: true,
      });
    }
    this.startedTaskCount = Math.max(this.startedTaskCount,
      Number(stored.startedTaskCount) || 0,
      stored.tasks.filter((record) => record && record.startedAt).length);
    // 兜底重放撤回/过期状态的依赖失效传播，防止上次落盘在传播中途退出。
    for (const task of this.tasks.values()) {
      const state = task.review && task.review.status;
      const invalidatedByTaskId = String((task.review && task.review.invalidatedByTaskId) || '');
      const isPropagationRoot = state === 'needs_recheck' &&
        (!invalidatedByTaskId || invalidatedByTaskId === task.taskId || !this.tasks.has(invalidatedByTaskId));
      if (state === 'retracted' || isPropagationRoot) {
        this.invalidateDependentTasks(context, task.taskId, task.review.reason || ('依赖任务 ' + task.taskId + ' 已失效'));
      }
    }
    this.taskViewsHydrated = true;
    return { ok: true, tasks: stored.tasks.length };
  }

  taskById(context, taskId) {
    this.hydrateTasks(context);
    return this.tasks.get(String(taskId || '')) || null;
  }

  /** 对任务信封重新校验产物与快照；旧版/损坏信封 fail closed。 */
  verifyTask(context, task) {
    const envelope = task && task.envelope;
    if (!envelope || envelope.kind !== 'result' || envelope.trust === 'untrusted') {
      return { verdict: 'invalid', checkedAt: Date.now(), files: [], sources: [], snapshot: null,
        reasons: ['任务没有可审查的可信候选结果信封'] };
    }
    const violations = subagentEnvelope.validateEnvelope(envelope);
    if (violations.length) {
      return { verdict: 'invalid', checkedAt: Date.now(), files: [], sources: [], snapshot: null,
        reasons: violations.map((item) => item.path + ': ' + item.message) };
    }
    return subagentEnvelope.verifyEnvelope(envelope, {
      projectRoot: task.artifactRoot || (typeof context.projectRoot === 'function' ? context.projectRoot() : ''),
      model: typeof context.model === 'function' ? context.model() : null,
    });
  }

  /** 已确认结果允许以主代理最近一次人工复核的画布快照为基线；之后再变化仍会失效。 */
  verifyTaskForSharing(context, task) {
    const verification = this.verifyTask(context, task);
    const review = task && task.review;
    const source = review && review.status === 'confirmed' && review.source || {};
    const basis = source.validationBasis || 'all';
    const entries = [...(verification.files || []), ...(verification.sources || [])];
    const hasVersion = (entry) => entry && (entry.versioned === true || !!entry.declared);
    if (verification.verdict === 'invalid') return verification;
    if (entries.some((entry) => !entry || entry.ok !== true)) return verification;
    if (entries.some((entry) => !hasVersion(entry))) {
      return { ...verification, verdict: 'unverifiable', reasons: ['至少一个文件/来源没有内容哈希，不能自动沿用该确认'] };
    }
    if (basis === 'canvas' && entries.length) {
      return { ...verification, verdict: 'unverifiable', reasons: ['canvas basis 不能覆盖文件或引用来源证据'] };
    }
    if (basis === 'filesystem' && !entries.length) {
      return { ...verification, verdict: 'unverifiable', reasons: ['filesystem 确认缺少文件/来源版本引用'] };
    }
    if (basis === 'filesystem' || basis === 'manual') {
      return { ...verification, verdict: 'valid', reasons: [], validationBasis: basis };
    }
    const reviewedSnapshotHash = source.reviewedSnapshotHash;
    if (verification.verdict === 'valid') return verification;
    if (verification.verdict === 'stale' && reviewedSnapshotHash &&
        reviewedSnapshotHash === (verification.snapshot && verification.snapshot.actual)) {
      return { ...verification, verdict: 'valid', reasons: [], reviewedSnapshotHash, validationBasis: basis };
    }
    return verification;
  }

  confirmableVerification(context, task, basis) {
    const verification = this.verifyTask(context, task);
    const entries = [...(verification.files || []), ...(verification.sources || [])];
    const hasVersion = (entry) => entry && (entry.versioned === true || !!entry.declared);
    const grounding = task.grounding || (task.envelope && task.envelope.payload && task.envelope.payload.grounding) || {};
    if (grounding.required === true && grounding.valid !== true) {
      return { ok: false, verification, error: '候选结果的来源引用未通过 grounding 校验，不能确认' };
    }
    const cited = (Array.isArray(grounding.used) ? grounding.used : []).map(String);
    const pinnedSources = (task.envelope && task.envelope.evidence && task.envelope.evidence.sources) || [];
    const unpinnedGrounding = cited.filter((citation) => {
      if (citation.startsWith('scalar:')) return true;
      const rangeMatch = /^(.*)#L(\d+)-L(\d+)$/.exec(citation);
      const sourcePath = String(rangeMatch ? rangeMatch[1] : citation).replace(/\\/g, '/');
      const startLine = rangeMatch ? Number(rangeMatch[2]) : null;
      const endLine = rangeMatch ? Number(rangeMatch[3]) : null;
      const matchingSource = pinnedSources.find((source) => String(source.path || '').replace(/\\/g, '/') === sourcePath);
      if (!matchingSource || !matchingSource.versioned) return true;
      if (matchingSource.wholeFile && matchingSource.sha256) return false;
      return !matchingSource.ranges.some((range) => range.sha256 && startLine != null && endLine != null &&
        range.startLine <= startLine && range.endLine >= endLine);
    });
    if (verification.verdict === 'invalid') return { ok: false, verification, error: verification.reasons.join('；') };
    if (entries.some((entry) => !entry || entry.ok !== true)) {
      return { ok: false, verification, error: '文件或引用来源版本已变化，不能确认' };
    }
    if (entries.some((entry) => !hasVersion(entry))) {
      return { ok: false, verification, error: '文件或引用来源没有可比对的内容哈希；请缩小来源范围后重做' };
    }
    if (basis === 'canvas' && entries.length) {
      return { ok: false, verification, error: 'canvas basis 只适用于没有文件/引用来源依赖的画布结论' };
    }
    if (basis !== 'manual' && unpinnedGrounding.length) {
      return { ok: false, verification,
        error: 'RAG/标量引用没有锁定到 live 文件版本；请先用 read_file/search_files 核对，或明确选择 manual 并在 note 中保留 citation' };
    }
    if (basis === 'filesystem') {
      if (!entries.length) return { ok: false, verification, error: 'filesystem 核验需要至少一个带哈希的文件/来源引用' };
      return { ok: true, verification, reviewedSnapshotHash: null };
    }
    if (basis === 'manual') return { ok: true, verification, reviewedSnapshotHash: null };
    if (verification.verdict === 'valid') {
      return { ok: true, verification, reviewedSnapshotHash: verification.snapshot && verification.snapshot.actual || null };
    }
    const staleOnly = verification.verdict === 'stale' && verification.snapshot && verification.snapshot.actual;
    if (staleOnly) return { ok: true, verification, reviewedSnapshotHash: verification.snapshot.actual };
    return { ok: false, verification, error: '当前快照不是 valid，确认前需重新核对' };
  }

  persistTask(context, task) {
    const root = typeof context.projectRoot === 'function' ? context.projectRoot() : '';
    return persistTaskView(root, this.runId, taskView(task), { maxTasks: this.subCfg.maxTasksPerRun });
  }

  markNeedsRecheck(context, task, reason, invalidatedByTaskId) {
    if (!task || (task.review && task.review.status === 'retracted')) return;
    const normalizedReason = String(reason || '上游结果需要重新核验').slice(0, 1000);
    if (task.review && task.review.status === 'needs_recheck' && task.review.reason === normalizedReason) {
      this.invalidateDependentTasks(context, task.taskId, normalizedReason);
      return;
    }
    const at = new Date().toISOString();
    task.review = {
      ...(task.review || {}),
      status: 'needs_recheck',
      reason: normalizedReason,
      invalidatedByTaskId: String(invalidatedByTaskId || task.taskId),
      invalidatedAt: at,
    };
    try { this.persistTask(context, task); }
    catch (error) {
      context.audit(JSON.stringify({ kind: 'subagent_review_persist_failed', taskId: task.taskId,
        error: String((error && error.message) || error) }));
    }
    if (this.onDelta) this.onDelta({ kind: 'subagent_review', taskId: task.taskId, status: 'needs_recheck', reason: task.review.reason });
    this.invalidateDependentTasks(context, task.taskId, task.review.reason);
  }

  /**
   * 撤回/过期沿显式依赖边传播，不按任务先后猜依赖关系。
   * 这里只标 needs_recheck，不会自动重跑子任务；visited 防循环，节点数受 maxTasksPerRun 限制，
   * 因此不靠任意 depth cap 丢弃更深层的失效标记。
   */
  invalidateDependentTasks(context, sourceTaskId, reason) {
    const rootId = String(sourceTaskId || '');
    if (!rootId) return [];
    const visited = new Set([rootId]);
    const queue = [rootId];
    const invalidated = [];
    const dependentsByTaskId = new Map();
    for (const task of this.tasks.values()) {
      for (const dependencyId of Array.isArray(task.dependsOnTaskIds) ? task.dependsOnTaskIds : []) {
        const key = String(dependencyId || '');
        if (!key) continue;
        if (!dependentsByTaskId.has(key)) dependentsByTaskId.set(key, []);
        dependentsByTaskId.get(key).push(task);
      }
    }
    while (queue.length) {
      const dependencyId = queue.shift();
      for (const task of dependentsByTaskId.get(dependencyId) || []) {
        if (visited.has(task.taskId)) continue;
        visited.add(task.taskId);
        queue.push(task.taskId);
        const alreadyMarked = task.review && task.review.status === 'needs_recheck' &&
          task.review.invalidatedByTaskId === rootId;
        if (!alreadyMarked && (!task.review || task.review.status !== 'retracted')) {
          task.review = {
            ...(task.review || {}),
            status: 'needs_recheck',
            reason: String(reason || ('依赖任务 ' + rootId + ' 已失效')).slice(0, 1000),
            invalidatedByTaskId: rootId,
            invalidatedAt: new Date().toISOString(),
          };
          try { this.persistTask(context, task); }
          catch (error) {
            context.audit(JSON.stringify({ kind: 'subagent_review_persist_failed', taskId: task.taskId,
              error: String((error && error.message) || error) }));
          }
          invalidated.push(task.taskId);
          if (this.onDelta) this.onDelta({ kind: 'subagent_review', taskId: task.taskId,
            status: 'needs_recheck', invalidatedByTaskId: rootId });
        }
      }
    }
    return invalidated;
  }

  confirmedSources(context, taskIds) {
    this.hydrateTasks(context);
    const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    const sources = [];
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (!task || task.status !== 'done' || !task.envelope) {
        return { ok: false, error: '依赖任务不存在或未成功完成：' + id };
      }
      if (!task.review || task.review.status !== 'confirmed' || !task.review.confirmedSummary) {
        return { ok: false, error: '依赖任务尚未由主代理确认，不能作为共享内容传给下游：' + id };
      }
      const isolatedChanges = task.worktree &&
        ((Array.isArray(task.worktree.changed) && task.worktree.changed.length) || Number(task.worktree.commits) > 0);
      if (isolatedChanges && !task.review.integration) {
        return { ok: false, error: '依赖任务的隔离代码尚未与确认记录绑定，不能传给下游：' + id };
      }
      const verification = this.verifyTaskForSharing(context, task);
      task.verification = verification;
      if (verification.verdict !== 'valid') {
        this.markNeedsRecheck(context, task,
          '依赖任务 ' + id + ' 的产物/快照当前核验为 ' + verification.verdict + '：' + verification.reasons.join('；'), id);
        return { ok: false, error: '依赖任务需要重新核验，不能传给下游：' + id + '（' + verification.verdict + '）' };
      }
      sources.push({
        runId: task.runId || this.runId,
        taskId: id,
        msgId: task.envelope.msgId,
        snapshot: task.envelope.snapshot,
        confirmedAt: task.review.reviewedAt,
        reviewedBy: task.review.reviewedBy,
        confirmedSummary: task.review.confirmedSummary,
        reviewNote: task.review.note,
        validationBasis: task.review.source && task.review.source.validationBasis || 'all',
        reviewedSnapshotHash: task.review.source && task.review.source.reviewedSnapshotHash || null,
        resultDigest: task.review.source && task.review.source.resultDigest || null,
        independentVerification: task.review.source && task.review.source.verifier || null,
        evidence: task.envelope.evidence,
        grounding: task.grounding || task.envelope.payload.grounding || null,
      });
    }
    return { ok: true, taskIds: ids, sources };
  }

  verificationCandidate(context, role, sourceTaskId) {
    const id = String(sourceTaskId || '').trim();
    if (!id) return { ok: true, taskId: '', candidate: null, artifactRoot: '' };
    if (role !== 'verifier') return { ok: false, error: 'verifiesTaskId 只能用于 verifier 角色' };
    const source = this.taskById(context, id);
    if (!source || source.status !== 'done' || !source.envelope || source.envelope.kind !== 'result' ||
        source.envelope.trust === 'untrusted') {
      return { ok: false, error: '待核验任务不存在或没有成功的候选信封：' + id };
    }
    if (source.review && ['retracted', 'needs_recheck'].includes(source.review.status)) {
      return { ok: false, error: '待核验任务当前状态为 ' + source.review.status + '，请先处理来源状态：' + id };
    }
    const verification = this.verifyTask(context, source);
    if (verification.verdict === 'invalid') {
      this.markNeedsRecheck(context, source,
        '独立核验派发前发现产物失配：' + verification.reasons.join('；'), id);
      return { ok: false, error: '待核验产物已失配，不能派 verifier：' + id };
    }
    const resultDigest = mergeLib.sha256OfText(mergeLib.stableStringify(source.envelope));
    const summary = String(source.summary || source.envelope.payload.summary || '');
    return {
      ok: true,
      taskId: id,
      resultDigest,
      artifactRoot: source.artifactRoot || context.projectRoot(),
      candidate: {
        taskId: id,
        runId: source.runId || this.runId,
        msgId: source.envelope.msgId,
        resultDigest,
        objective: source.objective || source.envelope.payload.objective || '',
        acceptanceCriteria: Array.isArray(source.acceptanceCriteria) ? source.acceptanceCriteria.slice(0, 20) : [],
        summary: summary.slice(0, 12000),
        summaryChars: summary.length,
        summaryTruncated: summary.length > 12000 || !!(source.envelope.lossy && source.envelope.lossy.isLossy),
        changedFiles: (Array.isArray(source.envelope.refs) ? source.envelope.refs : []).map((ref) => ref.path).filter(Boolean),
        evidence: source.envelope.evidence,
      },
    };
  }

  independentVerification(context, candidateTask, verifierTaskId) {
    const id = String(verifierTaskId || '').trim();
    if (!id) return { ok: true, record: null };
    const verifier = this.taskById(context, id);
    if (!verifier || verifier.role !== 'verifier' || verifier.status !== 'done' ||
        !verifier.envelope || verifier.envelope.kind !== 'result' || verifier.envelope.trust === 'untrusted') {
      return { ok: false, error: 'verificationTaskId 必须指向成功完成的 verifier 任务' };
    }
    if (verifier.verifiesTaskId !== candidateTask.taskId) {
      return { ok: false, error: 'verifier 任务没有绑定待确认的候选任务' };
    }
    if (!Array.isArray(verifier.acceptanceCriteria) || !verifier.acceptanceCriteria.length) {
      return { ok: false, error: 'verifier 任务没有明确的验收条件，不能作为独立验证凭据' };
    }
    const candidateDigest = mergeLib.sha256OfText(mergeLib.stableStringify(candidateTask.envelope));
    if (!verifier.verificationCandidateDigest || verifier.verificationCandidateDigest !== candidateDigest) {
      return { ok: false, error: 'verifier 核验的来源版本与当前候选结果不一致' };
    }
    const startedAt = Date.parse(String(verifier.startedAt || ''));
    const candidateFinishedAt = Date.parse(String(candidateTask.finishedAt || ''));
    if (Number.isFinite(startedAt) && Number.isFinite(candidateFinishedAt) && startedAt < candidateFinishedAt) {
      return { ok: false, error: 'verifier 必须在候选任务完成后启动' };
    }
    const violations = subagentEnvelope.validateEnvelope(verifier.envelope);
    if (violations.length) return { ok: false, error: 'verifier 信封违约：' + violations.map((item) => item.path).join(', ') };
    const verifierEvidence = this.verifyTask(context, verifier);
    if (verifierEvidence.verdict === 'invalid' ||
        (verifierEvidence.files || []).some((file) => !file.ok) ||
        (verifierEvidence.sources || []).some((source) => !source.ok)) {
      return { ok: false, error: 'verifier 读取的文件/来源已变化，不能作为当前版本的独立验证凭据' };
    }
    const commands = (verifier.envelope.evidence && verifier.envelope.evidence.commands) || [];
    if (!commands.length || commands.some((command) => !Number.isInteger(command.exitCode) || command.passed !== true)) {
      return { ok: false, error: 'verifier 没有可核验的成功命令退出码；不得作为独立通过证据' };
    }
    return {
      ok: true,
      record: {
        taskId: verifier.taskId,
        runId: verifier.runId || this.runId,
        msgId: verifier.envelope.msgId,
        resultDigest: mergeLib.sha256OfText(mergeLib.stableStringify(verifier.envelope)),
        checkedAt: verifierEvidence.checkedAt,
        acceptanceCriteria: verifier.acceptanceCriteria.slice(0, 20),
        commands: commands.map((command) => ({ cmd: command.cmd, exitCode: command.exitCode, passed: command.passed })),
      },
    };
  }

  register(registry) {
    this.registry = registry;
    const roleList = roles.ROLE_NAMES.join('/');
    // 派活对照表：主代理必须能看出「这类工作该交给哪个角色」，否则会拿 explorer 去改代码、拿 reviewer 去跑测试
    const roleGuide = roles.ROLE_NAMES
      .map((name) => {
        const def = roles.roleDefinition(name);
        return '  - ' + name + '（' + (def ? def.label : name) + '）：' + (def ? def.work.join('；') : '');
      })
      .join('\n');
    registry.register(
      'delegate_task',
      '创建并执行一个受角色工具权限约束的子代理任务。单文件读取或一步可完成的问题由主 Agent 直接处理；独立探查、实现、验证或审查等多步工作再委派。\n按工作类型选角色：\n' + roleGuide +
        '\nstageNodeId 可绑定画布 stage 节点；timeoutSeconds 是**任务总时长**（秒，默认 ' + this.subCfg.totalTimeoutSeconds + '）。' +
        '\n结果默认以短候选卡回到父上下文；完整结论用 get_subagent_task(taskId, detail="full") 按页读取。' +
        'builder 改文件优先用 isolation=worktree；共享写入取消后无法安全回滚。' +
        '该模式只隔离项目文件，canvas 角色不支持，builder 的共享画布写工具会禁用；工作树创建失败会**中止任务**而不是静默降级。',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          role: { type: 'string', enum: roles.ROLE_NAMES },
          objective: { type: 'string' },
          inputs: { type: 'object' },
          dependsOnTaskIds: {
            type: 'array', items: { type: 'string' },
            description: '可选上游任务 id；每个 id 必须先由主代理确认且当前核验有效。下游只会收到已确认摘要、来源与证据。',
          },
          verifiesTaskId: { type: 'string', description: '仅 verifier 可填；独立核验一个未确认的候选任务。' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          stageNodeId: { type: 'string' },
          timeoutSeconds: { type: 'integer', description: '任务总时长（秒），超时会被中止' },
          maxTurns: { type: 'integer', description: '本子任务最多模型轮次，1-200；只能收紧本轮 agent.max_tool_iterations 上限' },
          tokenBudget: { type: 'integer', description: '本子任务独立 token 上限；仍受父 Run 总预算约束' },
          isolation: {
            type: 'string',
            enum: ['none', 'worktree'],
            description: 'worktree 隔离项目文件；不能用于 canvas 角色，且 builder 在此模式下不能写共享画布。改动需审查后再合并。',
          },
        },
        required: ['role', 'objective'],
      },
      (context, args) => this.delegate(context, args)
    );
    registry.register(
      'get_subagent_task',
      '读取已创建的子代理任务。默认返回短摘要与核验元数据；需要核对正文时传 detail="full"，使用 summaryOffset/summaryChars 分页展开。',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          detail: { type: 'string', enum: ['summary', 'full'], description: '默认 summary；full 返回原始结论的一页，并给出下一页游标。' },
          summaryOffset: { type: 'integer', description: 'detail=full 时的摘要字符起点，默认 0。' },
          summaryChars: { type: 'integer', description: 'detail=full 时的页长，默认 12000，最多 12000。' },
        },
        required: ['taskId'],
      },
      // 这里**需要** context（拿 projectRoot 与画布模型做接收侧核验），所以用实名参数
      async (context, args) => {
        const task = this.taskById(context, args.taskId) || this.reservations.get(String(args.taskId || ''))?.task;
        if (!task) return AgentToolResult.error('子代理任务不存在：' + String(args.taskId || ''));
        const view = taskView(task);
        /**
         * **接收侧核验**：读信封的这一刻跟当前世界对一次账（重算产物哈希 + 画布快照）。
         * 这是「不采信自述」的落点 —— 报告之后文件被改/画布被动过，只有重算才发现得了。
         * invalid（产物对不上）→ 拒收（工具结果 error + trust 降级）；stale（世界又变过）→ 交付但明确标出。
         */
        if (view.envelope) {
          const verification = this.verifyTaskForSharing(context, task);
          view.verification = verification;
          task.verification = verification;
          if (verification.verdict !== 'valid') {
            this.markNeedsRecheck(context, task,
              '候选结果在读取时核验为 ' + verification.verdict + '：' + verification.reasons.join('；'), task.taskId);
            view.review = task.review;
          }
          if (verification.verdict === 'invalid') {
            view.envelope = { ...view.envelope, trust: 'untrusted', verificationNote: verification.reasons.join('；') };
            context.audit(
              JSON.stringify({ kind: 'subagent_verification_failed', taskId: task.taskId, reasons: verification.reasons.slice(0, 5) })
            );
            const errorText = '该子代理结果的**接收侧核验未通过**，不得作为结论证据：\n- ' +
              verification.reasons.join('\n- ') +
              '\n如需继续用它，请先查明产物为何变化（或被改动的是你自己而不是它）。\n';
            const modelContent = args.detail === 'full'
              ? errorText + renderTaskFullPage(view, args.summaryOffset, args.summaryChars)
              : errorText + renderTaskModelCard(view);
            return AgentToolResult.error(modelContent, view, { modelContent });
          }
        }
        // A1 + fan-out 上下文控制：`data` 保留完整视图给 UI/审计；模型默认只看候选卡，完整结论按页展开。
        const modelContent = args.detail === 'full'
          ? renderTaskFullPage(view, args.summaryOffset, args.summaryChars)
          : renderTaskModelCard(view);
        return AgentToolResult.ok(modelContent, view, { modelContent });
      }
    );
    registry.register(
      'review_subagent_result',
      '审查候选结果；正文用 get_subagent_task(detail="full") 读取。' +
        '隔离代码用 confirm_and_merge：核对指纹、合入后确认。' +
        'confirm 前核对当前 verification，并按验收条件独立核对来源；哈希有效不等于结论正确。' +
        'confirm 需 confirmedSummary 和核验 note；verificationTaskId 可绑定独立 verifier。' +
        'validationBasis 可选 all/filesystem/canvas/manual；确认摘要才可作为下游依赖。' +
        '快照变化须复核，产物哈希不符不能确认；retract 使下游 needs_recheck。',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          decision: { type: 'string', enum: ['confirm', 'confirm_and_merge', 'retract'] },
          confirmedSummary: { type: 'string', description: 'confirm 时必填，最多 4000 字；由主代理复核后整理的可共享内容。' },
          note: { type: 'string', description: '必填。说明核验依据，或撤回原因。' },
          commitMessage: { type: 'string', description: 'confirm_and_merge 时隔离工作树有未提交改动则必填，最多 200 字。' },
          verificationTaskId: { type: 'string', description: '可选 verifier taskId；该 verifier 必须在此候选完成后针对同一信封版本运行成功命令。' },
          validationBasis: {
            type: 'string', enum: ['all', 'filesystem', 'canvas', 'manual'],
            description: 'confirm 时的有效期依据。filesystem 仅在来源/产物均有哈希时可用；canvas 仅适用于画布结论；manual 用于 RAG/标量/外部引用并须在 note 中保留 citation，仍核对已有文件哈希。默认 all。',
          },
        },
        required: ['taskId', 'decision', 'note'],
      },
      async (context, args) => {
        const actorRole = typeof context.role === 'function' ? context.role() : context.role;
        if (actorRole && actorRole !== 'supervisor') {
          return AgentToolResult.error('只有父任务可以确认或撤回共享候选结果');
        }
        const task = this.taskById(context, args.taskId);
        if (!task) return AgentToolResult.error('子代理任务不存在：' + String(args.taskId || ''));
        if (task.status !== 'done' || !task.envelope || task.envelope.kind !== 'result') {
          return AgentToolResult.error('只有成功完成且有 result 信封的子代理任务可以审查');
        }
        const decision = String(args.decision || '').trim();
        const note = String(args.note || '').trim();
        if (!note) return AgentToolResult.error('审查必须记录核验依据或撤回原因');
        if (note.length > 1000) return AgentToolResult.error('note 最多 1000 字，请保留关键核验依据');
        const reviewerId = String((typeof context.runId === 'function' ? context.runId() : context.runId) || this.runId);
        const previousReview = task.review;
        let integrated = null;
        if (decision === 'confirm' || decision === 'confirm_and_merge') {
          if (task.review && task.review.status === 'integrating') {
            return AgentToolResult.error('上次合入状态待人工核对；检查主分支与任务视图后再恢复，不能重复执行合并');
          }
          if (task.review && task.review.status === 'confirmed') {
            const existing = this.confirmedSources(context, [task.taskId]);
            if (!existing.ok) return AgentToolResult.error(existing.error);
            return AgentToolResult.ok('该子代理结果已经确认，无需重复合并',
              { taskId: task.taskId, review: task.review });
          }
          if (task.review && task.review.status === 'retracted') {
            return AgentToolResult.error('已撤回的候选结果不能重新确认；请基于最新状态重新派发任务');
          }
          const confirmedSummary = String(args.confirmedSummary || '').trim();
          if (!confirmedSummary) return AgentToolResult.error('确认候选结果时必须提供 confirmedSummary');
          if (confirmedSummary.length > 4000) return AgentToolResult.error('confirmedSummary 最多 4000 字');
          const validationBasis = String(args.validationBasis || 'all').trim();
          if (!['all', 'filesystem', 'canvas', 'manual'].includes(validationBasis)) {
            return AgentToolResult.error('validationBasis 必须是 all/filesystem/canvas/manual');
          }
          const independent = this.independentVerification(context, task, args.verificationTaskId);
          if (!independent.ok) return AgentToolResult.error(independent.error);
          const dependencies = this.confirmedSources(context, task.dependsOnTaskIds);
          if (!dependencies.ok) {
            this.markNeedsRecheck(context, task, '上游依赖尚未有效确认：' + dependencies.error, task.taskId);
            return AgentToolResult.error(dependencies.error);
          }
          const confirmation = this.confirmableVerification(context, task, validationBasis);
          const verification = confirmation.verification;
          task.verification = verification;
          if (!confirmation.ok) {
            this.markNeedsRecheck(context, task,
              '确认前核验为 ' + verification.verdict + '：' + (verification.reasons || []).join('；'), task.taskId);
            return AgentToolResult.error('候选结果不能按 ' + validationBasis + ' 确认：' + confirmation.error);
          }
          if (validationBasis === 'manual') {
            const grounding = task.grounding || (task.envelope.payload && task.envelope.payload.grounding) || {};
            const citations = Array.isArray(grounding.used) ? grounding.used.map(String) : [];
            if (citations.length && !citations.some((citation) => note.includes(citation))) {
              return AgentToolResult.error('manual basis 必须在 note 中保留至少一个已用 citation，便于下游追溯');
            }
          }
          const isolatedChanges = !!(task.worktree &&
            ((Array.isArray(task.worktree.changed) && task.worktree.changed.length) || Number(task.worktree.commits) > 0));
          if (isolatedChanges && decision !== 'confirm_and_merge') {
            return AgentToolResult.error('隔离工作树仍有代码改动；须使用 confirm_and_merge，合入成功前不能标记 confirmed');
          }
          if (decision === 'confirm_and_merge') {
            if (!isolatedChanges) return AgentToolResult.error('该任务没有待合入的隔离工作树改动');
            const pinned = task.worktree.sourceSnapshot;
            if (!pinned || !pinned.ok) return AgentToolResult.error('子任务结束时未能锁定隔离工作树内容，不能自动合并');
            const root = typeof context.projectRoot === 'function' ? context.projectRoot() : '';
            const opts = { context, policy: typeof context.sandbox === 'function' ? context.sandbox() : null };
            const preview = await worktreeLib.inspectMerge(root, task.taskId, opts);
            if (!preview.ok) return AgentToolResult.error('隔离工作树预检失败：' + preview.message, preview);
            const drift = [];
            if (worktreeLib.normalizePath(preview.path || '') !== worktreeLib.normalizePath(task.worktree.path)) drift.push('path');
            if (preview.branch !== task.worktree.branch) drift.push('branch');
            if (preview.sourceHead !== pinned.sourceHead) drift.push('head');
            if (preview.pendingDigest !== pinned.pendingDigest) drift.push('pending');
            if (drift.length) {
              this.markNeedsRecheck(context, task, '子任务结束后隔离工作树版本发生变化：' + drift.join(','), task.taskId);
              return AgentToolResult.error('隔离工作树内容与子任务结束时不同（' + drift.join(',') + '），已标记 needs_recheck；请重新核验');
            }
            const approved = await context.confirm(ConfirmationLevel.WRITE,
              '确认并合入子代理结果 ' + task.taskId,
              '将 ' + (preview.files || []).length + ' 个文件从 ' + preview.branch + ' 合入 ' + preview.targetBranch +
              '；冲突会在写入主工作树前拦截，合入成功后才向下游开放确认摘要。');
            if (!approved) return AgentToolResult.error('用户未批准，未合入也未确认子代理结果');
            task.review = { status: 'integrating', targetHead: preview.targetHead,
              sourceHead: preview.sourceHead, pendingDigest: preview.pendingDigest,
              startedAt: new Date().toISOString(), reviewedBy: reviewerId };
            try { this.persistTask(context, task); }
            catch (error) {
              task.review = previousReview;
              return AgentToolResult.error('合入意图未能持久化，未修改主工作树：' + String((error && error.message) || error));
            }
            const merge = await worktreeLib.mergeWorktree(root, {
              name: task.taskId, expectedTargetHead: preview.targetHead,
              expectedSourceHead: preview.sourceHead, expectedTargetBranch: preview.targetBranch,
              expectedPendingDigest: preview.pendingDigest, commitMessage: args.commitMessage,
            }, opts);
            if (!merge.ok) {
              task.review = { status: merge.error === 'MERGE_CONFLICT' ? 'conflict_blocked' : 'candidate',
                reason: merge.message, failedAt: new Date().toISOString() };
              try { this.persistTask(context, task); }
              catch (error) { return AgentToolResult.error('合并失败且状态落盘失败，请检查任务视图：' + String(error.message || error), merge); }
              return AgentToolResult.error('代码未合入，结果未确认：' + merge.message, merge);
            }
            integrated = { targetBranch: merge.targetBranch, targetHead: merge.head,
              previousTargetHead: merge.previousTargetHead, sourceHead: merge.sourceHead,
              files: merge.files, mergedAt: new Date().toISOString() };
            const afterMerge = this.confirmableVerification(context, task, validationBasis);
            if (!afterMerge.ok) {
              task.review = { status: 'needs_recheck', integration: integrated,
                reason: '代码已合入，但合入后证据版本变化：' + afterMerge.error };
              try { this.persistTask(context, task); } catch {}
              return AgentToolResult.error('代码已合入，但结果未确认：' + afterMerge.error);
            }
          }
          task.review = {
            status: 'confirmed',
            confirmedSummary,
            note,
            ...(integrated ? { integration: integrated } : {}),
            reviewedAt: new Date().toISOString(),
            reviewedBy: reviewerId,
            source: {
              runId: task.runId || this.runId,
              taskId: task.taskId,
              msgId: task.envelope.msgId,
              snapshotHash: task.envelope.snapshot && task.envelope.snapshot.hash || null,
              snapshotRevision: task.envelope.snapshot && task.envelope.snapshot.revision != null
                ? task.envelope.snapshot.revision : null,
              reviewedSnapshotHash: confirmation.reviewedSnapshotHash,
              validationBasis,
              resultDigest: mergeLib.sha256OfText(mergeLib.stableStringify(task.envelope)),
              verificationVerdict: verification.verdict,
              verification: {
                checkedAt: verification.checkedAt,
                snapshot: verification.snapshot,
                files: verification.files.map((file) => ({
                  path: file.path,
                  expected: file.declared || null,
                  actual: file.actual || null,
                  ok: file.ok === true,
                })),
                sources: (verification.sources || []).map((source) => ({
                  path: source.path, versioned: source.versioned, checkedBy: source.checkedBy, ranges: source.ranges,
                  citations: source.citations, ok: source.ok === true,
                })),
              },
              ...(independent.record ? { verifier: independent.record } : {}),
            },
          };
        } else if (decision === 'retract') {
          if (task.review && task.review.status === 'retracted') {
            return AgentToolResult.error('该候选结果已经撤回');
          }
          task.review = {
            status: 'retracted',
            note,
            retractedAt: new Date().toISOString(),
            retractedBy: reviewerId,
            source: {
              runId: task.runId || this.runId,
              taskId: task.taskId,
              msgId: task.envelope.msgId,
              snapshotHash: task.envelope.snapshot && task.envelope.snapshot.hash || null,
              snapshotRevision: task.envelope.snapshot && task.envelope.snapshot.revision != null
                ? task.envelope.snapshot.revision : null,
            },
          };
        } else {
          return AgentToolResult.error('decision 必须是 confirm、confirm_and_merge 或 retract');
        }
        try {
          this.persistTask(context, task);
        } catch (error) {
          task.review = integrated ? { status: 'integrating', integration: integrated,
            reason: '代码已合入，但确认记录落盘失败；下游仍被阻断，请人工核对' } : previousReview;
          return AgentToolResult.error((integrated ? '代码已合入，但' : '') + '审查记录未能持久化，结果未对下游确认：' + String((error && error.message) || error));
        }
        const invalidated = decision === 'retract'
          ? this.invalidateDependentTasks(context, task.taskId, '上游候选结果已撤回：' + note)
          : [];
        context.audit(JSON.stringify({ kind: 'subagent_result_review', runId: this.runId, taskId: task.taskId,
          decision, sourceMsgId: task.envelope.msgId }));
        if (this.onDelta) this.onDelta({ kind: 'subagent_review', taskId: task.taskId, status: task.review.status });
        const resultText = decision === 'confirm' || decision === 'confirm_and_merge'
            ? '已确认子代理结果 ' + task.taskId + (integrated ? '，代码已合入 ' + integrated.targetBranch + '（' + integrated.targetHead + '）' : '') +
              '。下游可用 dependsOnTaskIds 引用它；共享内容会携带来源和证据。'
            : '已撤回子代理结果 ' + task.taskId + '；' + invalidated.length + ' 个依赖任务已标记 needs_recheck。';
        return AgentToolResult.ok(resultText, { taskId: task.taskId, review: task.review }, { modelContent: resultText });
      }
    );
    registry.register(
      'cancel_subagent_task',
      '取消一个**正在运行**的子代理任务（只取消这一个，不影响主 Agent 与其他子代理；隔离工作树保留待复核，共享工作区已发生的写入不能自动回滚）。',
      {
        type: 'object',
        properties: { taskId: { type: 'string' }, reason: { type: 'string' } },
        required: ['taskId'],
      },
      async (context, args) => {
        const taskId = String(args.taskId || '');
        const reservation = this.reservations.get(taskId);
        const task = this.tasks.get(taskId) || (reservation && reservation.task);
        if (!task) return AgentToolResult.error('子代理任务不存在：' + taskId);
        if (!reservation && task.status !== 'running') return AgentToolResult.error('子代理任务已结束（status=' + task.status + '），无需取消');
        // 只 abort 这一个子任务自己的 controller（父信号/其他子代理不受影响）
        task.cancelRequested = true;
        task.cancelReason = String(args.reason || '主 Agent 主动取消');
        transitionTask(task, 'cancelling');
        if (reservation) reservation.controller.abort();
        if (task.controller && !task.controller.signal.aborted) task.controller.abort();
        context.audit(JSON.stringify({ kind: 'subagent_cancel', runId: this.runId, taskId, role: task.role, reason: task.cancelReason }));
        if (this.onDelta) this.onDelta({ kind: 'subagent_state', taskId, role: task.role, status: 'cancelling', summary: task.cancelReason });
        // §4.2：取消也落盘（否则「派了谁、为什么没做完」在盘上查不到）
        try {
          this.persistTask(context, task);
        } catch {
          /* 落盘失败不影响取消本身 */
        }
        const location = task.worktree && task.worktree.path
          ? '；隔离改动仍在 ' + task.worktree.path + '，不会自动合入主工作树，结算后请复核'
          : '；若任务写入共享工作区，已发生的写入需要逐项复核，不能安全地自动回滚';
        return AgentToolResult.ok('已请求取消子代理任务 ' + taskId + '，等待执行退出' + location + '。',
          { taskId, role: task.role, status: 'cancelling', executionSettled: false, worktree: task.worktree || null });
      }
    );
    registry.register(
      'delegate_tasks',
      '批量执行子代理任务（共享并发上限；无 shell 的只读任务及独立 worktree 任务可并行，共享工作树写入独占；全部结算后返回成功和失败清单）。',
      {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                role: { type: 'string', enum: roles.ROLE_NAMES },
                objective: { type: 'string' },
                inputs: { type: 'object' },
                acceptanceCriteria: { type: 'array', items: { type: 'string' } },
                stageNodeId: { type: 'string' },
                timeoutSeconds: { type: 'integer' },
                maxTurns: { type: 'integer' },
                tokenBudget: { type: 'integer' },
                isolation: { type: 'string', enum: ['none', 'worktree'] },
                dependsOnTaskIds: { type: 'array', items: { type: 'string' } },
                verifiesTaskId: { type: 'string' },
              },
              required: ['role', 'objective'],
            },
          },
        },
        required: ['tasks'],
      },
      async (context, args) => {
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (!tasks.length) return AgentToolResult.error('缺少 tasks');
        if (tasks.length > this.subCfg.maxBatchTasks) {
          return AgentToolResult.error('单次最多委派 ' + this.subCfg.maxBatchTasks + ' 个子代理任务');
        }
        if (tasks.some((item) => !item || !roles.roleDefinition(item.role) || !String(item.objective || '').trim())) {
          return AgentToolResult.error('tasks 中存在无效的 role 或 objective（可选角色：' + roleList + '）');
        }
        const prepared = tasks.map((item) => ({ ...item, taskId: String(item.taskId || '').trim() || makeTaskId() }));
        const taskIds = prepared.map((item) => item.taskId);
        if (new Set(taskIds).size !== taskIds.length || taskIds.some((taskId) => this.tasks.has(taskId) || this.reservations.has(taskId))) {
          return AgentToolResult.error('批量任务的 taskId 必须互不重复，且不能复用本轮已有任务');
        }
        const batchId = makeTaskId().replace(/^task-/, 'batch-');
        const projectRoot = context.projectRoot();
        const checkpoint = projectRoot
          ? require('./runCheckpoint.cjs').appendCheckpoint(projectRoot, this.runId, {
              type: 'subagent_batch_start', batchId, taskIds, join: 'all_settled',
            })
          : null;
        if (projectRoot && !checkpoint) return AgentToolResult.error('无法持久化子任务汇合记录，已停止派发');
        // 所有入口都进入管理器级 FIFO；并行资格由 parallelSafeTask 在统一调度器中判定。
        const results = await runBatchTasks(prepared, prepared.length, (item) => this.delegate(context, item));
        /**
         * P5 确定性合并：把这一批信封里的「对世界声称了什么」合并成一份报告。
         * 合并只用贡献项自身的字段（资源键/内容/完成时刻/来源），**不看到达顺序** ——
         * 同一批工作无论谁先返回，digest 逐字节相同。冲突不会被默认消解（requiresArbitration）。
         */
        const envelopes = results
          .filter((result) => result && result.ok === true)
          .map((result) => result && result.data && result.data.envelope)
          .filter((envelope) => envelope && envelope.kind === 'result' && envelope.trust !== 'untrusted');
        const contributions = envelopes.reduce((acc, env) => acc.concat(mergeLib.contributionsFromEnvelope(env)), []);
        const merged = mergeLib.merge({ contributions });
        context.audit(
          JSON.stringify({ kind: 'subagent_batch_merged', runId: this.runId, digest: merged.digest, counts: merged.counts })
        );
        if (this.onDelta) {
          this.onDelta({ kind: 'subagent_merge', digest: merged.digest, counts: merged.counts });
        }
        /**
         * #5（同类未单列）：单条 `delegate_task` 在失败/违约时返回 `error`，而这里此前**无条件**
         * 用 `AgentToolResult.ok` 汇总 —— 把 8 个「违约不得采信」的子结果包装成一次成功调用，
         * 主代理据此把半截/失败报告当证据。只要有任一子结果 `ok !== true`，整批就是失败的调用。
         */
        const failedResults = results.filter((result) => !result || result.ok !== true);
        const finished = projectRoot
          ? require('./runCheckpoint.cjs').appendCheckpoint(projectRoot, this.runId, {
              type: 'subagent_batch_finish', batchId, taskIds, failedCount: failedResults.length, digest: merged.digest,
            })
          : null;
        const body = results.map((result) => (result && result.text) || '').join('\n') +
          '\n\n【候选合并；仅供主代理核验，不是已确认共享事实】\n' + mergeLib.renderMergeReport(merged);
        const modelBody = renderBatchModelContent(results, merged);
        const data = {
          batchOutcome: failedResults.length === 0 ? 'success' : failedResults.length === results.length ? 'failed' : 'partial_success',
          successfulTaskIds: results.flatMap((result, index) => result && result.ok === true ? [taskIds[index]] : []),
          failedTaskIds: results.flatMap((result, index) => !result || result.ok !== true ? [taskIds[index]] : []),
          results: results.map((result) => taskView((result && result.data) || {})),
          merged: { digest: merged.digest, counts: merged.counts, conflicts: merged.conflicts, sharedContentStatus: 'candidate' },
          candidateTaskIds: results.filter((result) => result && result.ok === true && result.data && result.data.taskId)
            .map((result) => result.data.taskId),
          failedCount: failedResults.length,
        };
        if (projectRoot && !finished) return AgentToolResult.error(body + '\n子任务结果未能写入汇合检查点，请复核后续跑。', data);
        if (failedResults.length) {
          return AgentToolResult.error(
            body +
              '\n（本批 ' +
              failedResults.length +
              '/' +
              results.length +
              ' 个子代理任务**未成功**：它们的结论不得作为证据；逐条原因见上面的信封与 payload.error，' +
              '可按违约项让子代理重做或由主代理直接完成这一步。）',
            data,
            { modelContent: modelBody + '\n本批有 ' + failedResults.length + ' 个任务未成功，失败结果不得作为证据。' }
          );
        }
        return AgentToolResult.ok(body, data, { modelContent: modelBody });
      }
    );

    registry.register(
      'merge_subagent_results',
      '把**当前核验有效**的子代理候选结果确定性合并成一份报告：同一组结果无论到达顺序如何，digest 逐字节相同。' +
        '内容一致 → agreed；有明确先后 → superseded（记清谁覆盖谁，两份都留痕）；' +
        '无法判定先后 → conflict，**不得默认取胜者** —— 用 decisions 显式裁决（只能指向该资源的候选 taskId）。' +
        '这仍然只是候选合并报告，不会把结果升级为共享事实；升级需单独调用 review_subagent_result。',
      {
        type: 'object',
        properties: {
          taskIds: { type: 'array', items: { type: 'string' }, description: '要合并的任务 id（缺省 = 本轮所有已完成且有信封的任务）' },
          detail: { type: 'string', enum: ['summary', 'full'], description: '默认 summary；full 返回全部资源候选。' },
          decisions: {
            type: 'array',
            items: { type: 'object' },
            description: '冲突裁决：[{resourceKey, winnerTaskId, note?}]；winnerTaskId 必须是该资源的候选来源之一',
          },
        },
      },
      async (context, args) => {
        this.hydrateTasks(context);
        const wanted = Array.isArray(args.taskIds) && args.taskIds.length ? args.taskIds.map(String) : null;
        const selected = [...this.tasks.values()].filter((task) => !wanted || wanted.includes(task.taskId));
        const tasks = [];
        const rejected = [];
        const stale = [];
        for (const task of selected) {
          if (task.status !== 'done' || task.requiresReview || !task.envelope || task.envelope.kind !== 'result' || task.envelope.trust === 'untrusted') {
            rejected.push({ taskId: task.taskId, reason: '没有成功完成的可信候选信封' });
            continue;
          }
          if (task.review && task.review.status === 'retracted') {
            rejected.push({ taskId: task.taskId, reason: task.review.status + (task.review.reason ? '：' + task.review.reason : '') });
            continue;
          }
          const verification = task.review && task.review.status === 'confirmed'
            ? this.verifyTaskForSharing(context, task)
            : this.verifyTask(context, task);
          task.verification = verification;
          if (verification.verdict !== 'valid') {
            this.markNeedsRecheck(context, task,
              '合并前核验为 ' + verification.verdict + '：' + verification.reasons.join('；'), task.taskId);
            stale.push({ taskId: task.taskId, reason: verification.verdict + '：' + verification.reasons.join('；') });
          }
          tasks.push(task);
        }
        if (!tasks.length) {
          const missing = wanted ? wanted.filter((id) => !this.tasks.has(id)) : [];
          const details = rejected.concat(missing.map((taskId) => ({ taskId, reason: '任务不存在或未恢复' })));
          return AgentToolResult.error('没有可合并的候选结果。拒收：' + JSON.stringify(details));
        }
        const contributions = tasks.reduce((acc, task) => acc.concat(mergeLib.contributionsFromEnvelope(task.envelope)), []);
        const merged = mergeLib.merge({ contributions, decisions: args.decisions });
        context.audit(
          JSON.stringify({
            kind: 'subagent_merge_requested',
            runId: this.runId,
            taskIds: tasks.map((task) => task.taskId),
            digest: merged.digest,
            counts: merged.counts,
            decidedKeys: (Array.isArray(args.decisions) ? args.decisions : []).map((d) => d && d.resourceKey),
          })
        );
        const rejectedText = rejected.length
          ? '\n\n未并入（需重做或复核）：\n' + rejected.map((item) => '- ' + item.taskId + '：' + item.reason).join('\n')
          : '';
        const staleText = stale.length
          ? '\n\n已并入但待复核（不得确认为共享事实）：\n' + stale.map((item) => '- ' + item.taskId + '：' + item.reason).join('\n')
          : '';
        const candidateNotice = '【候选合并；不是已确认共享事实】\n'
          + '下面的合并仅归并来源声明。即使冲突已按 decisions 裁决，仍需 review_subagent_result 对来源任务明确确认后，下游才能读取。\n';
        const report = mergeLib.renderMergeReport(merged, { compact: false });
        const modelContent = candidateNotice + (args.detail === 'full'
          ? report + rejectedText + staleText
          : renderMergeModelCard(merged) + (rejected.length
            ? '\n未并入 ' + rejected.length + ' 个任务；需要时用 detail="full" 或 get_subagent_task 展开。'
            : '') + (stale.length ? '\n待复核 ' + stale.length + ' 个任务，不能提升为共享事实。' : ''));
        return AgentToolResult.ok(candidateNotice + report + rejectedText + staleText, {
          merged,
          taskIds: tasks.map((task) => task.taskId),
          candidateTaskIds: tasks.filter((task) => !task.review || task.review.status !== 'confirmed').map((task) => task.taskId),
          sharedContentStatus: 'candidate',
          sources: tasks.map((task) => ({ taskId: task.taskId, msgId: task.envelope.msgId,
            snapshotHash: task.envelope.snapshot && task.envelope.snapshot.hash || null })),
          rejected,
          stale,
        }, { modelContent });
      }
    );
    require('./tools/builtInOutputSchemas.cjs').declareOutputContracts(registry, ['delegate_task', 'get_subagent_task', 'review_subagent_result', 'cancel_subagent_task', 'delegate_tasks', 'merge_subagent_results']);
  }

  async delegate(context, args) {
    if (typeof context.cancelled === 'function' && context.cancelled()) return AgentToolResult.error('主 Agent 已取消，未启动子代理');
    this.hydrateTasks(context);
    const taskId = String(args.taskId || '').trim() || makeTaskId();
    if (this.tasks.has(taskId) || this.reservations.has(taskId)) return AgentToolResult.error('taskId 已被占用：' + taskId);
    if (!roles.roleDefinition(args.role) || !String(args.objective || '').trim()) return AgentToolResult.error('无效的 role 或 objective');
    const parent = typeof context.signal === 'function' ? context.signal() : null;
    const controller = new AbortController();
    const totalMs = clampTotalTimeout(args.timeoutSeconds, this.subCfg.totalTimeoutSeconds);
    const queuedAt = new Date().toISOString();
    const lifecycle = {
      controller, timedOut: false,
      task: { taskId, executionId: randomUUID(), runId: this.runId, role: args.role, objective: args.objective, status: 'queued', queuedAt,
        deadline: new Date(Date.now() + totalMs).toISOString(), executionSettled: false },
    };
    const traceRoot = typeof context.projectRoot === 'function' ? context.projectRoot() : null;
    const parentTrace = typeof context.traceContext === 'function' ? context.traceContext() : null;
    const traceSpan = traceRoot ? require('./eventBus.cjs').startSpan(traceRoot, {
      spanKind: 'subagent', name: 'agent.subtask', runId: this.runId, parent: parentTrace,
      actor: taskId, attributes: { role: String(args.role || ''), taskId },
    }) : null;
    const cancel = () => {
      const task = this.tasks.get(taskId) || lifecycle.task;
      task.cancelReason = task.cancelReason || (lifecycle.timedOut ? 'deadline_exceeded' : 'parent_cancelled');
      transitionTask(task, 'cancelling');
      try { this.persistTask(context, task); } catch {}
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    const onParentAbort = () => controller.abort();
    if (parent) parent.addEventListener('abort', onParentAbort, { once: true });
    this.reservations.set(taskId, lifecycle);
    let release = null;
    let result;
    const timer = setTimeout(() => { lifecycle.timedOut = true; controller.abort(); }, totalMs);
    try {
      this.persistTask(context, lifecycle.task);
      if ((parent && parent.aborted) || (typeof context.cancelled === 'function' && context.cancelled())) controller.abort();
      release = await this.scheduler.acquire(parallelSafeTask(args), controller.signal);
      if (controller.signal.aborted) throw new Error('子任务已取消');
      const executionContext = context.fork({ signal: controller.signal, readOnly: context.readOnly(), traceContext: traceSpan?.context || parentTrace });
      result = await this.executeTask(executionContext, { ...args, taskId }, lifecycle);
    } catch (error) {
      result = AgentToolResult.error(String((error && error.message) || error), { taskId, status: 'failed' });
    } finally {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onParentAbort);
      controller.signal.removeEventListener('abort', cancel);
      const task = this.tasks.get(taskId) || lifecycle.task;
      if (traceSpan) traceSpan.end(controller.signal.aborted ? 'cancelled' : result?.ok ? 'ok' : 'error', {
        usage: result?.data?.usage || null, attributes: { status: task.status || null, requiresReview: task.requiresReview === true },
      });
      const started = !!task.startedAt;
      if (controller.signal.aborted) {
        transitionTask(task, lifecycle.timedOut ? 'blocked' : 'cancelled');
        task.outcomeReason = lifecycle.timedOut ? 'deadline_exceeded' : task.cancelReason || 'parent_cancelled';
        task.requiresReview = started && !READ_ONLY_ROLES.has(args.role);
        task.error = (task.cancelRequested ? '子代理任务被主动取消；' : '') + '子任务执行已返回，原因：' + task.outcomeReason + '；已发生的副作用不会回滚。';
        task.envelope = null;
        result = AgentToolResult.error(task.error, taskView(task));
      } else if (!result || !result.ok) {
        transitionTask(task, ['failed', 'blocked', 'cancelled'].includes(task.outcomeStatus) ? task.outcomeStatus : 'failed');
        task.error = task.error || (result && result.text) || '子任务执行失败';
        task.outcomeReason = 'task_failed';
        task.requiresReview = started && !READ_ONLY_ROLES.has(args.role);
      } else {
        transitionTask(task, 'done');
      }
      task.queuedAt = lifecycle.task.queuedAt;
      task.deadline = lifecycle.task.deadline;
      task.executionSettled = true; // 只确认本地执行 Promise 退出，不宣称外部副作用已撤销。
      task.finishedAt = new Date().toISOString();
      this.tasks.set(taskId, task);
      try {
        if (this.leases) {
          const released = this.leases.releaseAll(taskId);
          if (released) context.audit(JSON.stringify({ kind: 'subagent_leases_released', taskId, released }));
        }
        const settled = require('./runCheckpoint.cjs').appendCheckpoint(context.projectRoot(), this.runId, {
          type: 'subagent_task_settled', taskId, task: {
            taskId, executionId: task.executionId, role: task.role, status: task.status, executionSettled: true,
            requiresReview: task.requiresReview === true, outcomeReason: task.outcomeReason || null,
          },
        });
        if (!settled) throw new Error('任务结算检查点写入失败');
        this.persistTask(context, task);
      } catch (error) {
        task.requiresReview = true;
        result = AgentToolResult.error('子任务收尾记录失败，必须复核：' + String(error.message || error), taskView(task));
      } finally {
        this.reservations.delete(taskId);
        if (release) release();
      }
      if (result) result.data = { ...(result.data || {}), ...taskView(task) };
      try { context.audit(JSON.stringify({ kind: 'subagent_end', runId: this.runId, taskId, role: task.role, status: task.status })); } catch {}
      if (this.onDelta) {
        try { this.onDelta({ kind: 'subagent_state', taskId, role: task.role, status: task.status, summary: String(task.error || task.summary || '').slice(0, 200) }); } catch {}
      }
    }
    const finishedTask = this.tasks.get(taskId);
    try { await this.updateStage(context, finishedTask, finishedTask.status, String((result && result.text) || finishedTask.error || finishedTask.summary || '').slice(0, 4000)); } catch {}
    if (result && result.data) result.data.stageWarning = finishedTask.stageWarning || null;
    return result;
  }

  async executeTask(context, args, lifecycle) {
    if (typeof context.cancelled === 'function' && context.cancelled()) return AgentToolResult.error('主 Agent 已取消，未启动子代理');
    // #18：配额按「曾进入 running」计数，不按 tasks.size（模型复用同一 taskId 会让后者恒为 1）
    if (this.startedTaskCount >= this.subCfg.maxTasksPerRun) {
      return AgentToolResult.error(
        '本轮最多执行 ' + this.subCfg.maxTasksPerRun + ' 个子代理任务（已启动 ' + this.startedTaskCount + ' 个）'
      );
    }
    const role = String(args.role || '').trim();
    const objective = String(args.objective || '').trim();
    if (!roles.roleDefinition(role)) {
      return AgentToolResult.error('不支持的子代理角色：' + role + '（可选：' + roles.ROLE_NAMES.join('/') + '）');
    }
    if (!objective) return AgentToolResult.error('缺少子代理 objective');
    if (String(args.isolation || 'none').trim() === 'worktree' && role === 'canvas') {
      return AgentToolResult.error('worktree 只隔离项目文件，canvas 操作仍会影响共享画布；canvas 角色不能使用 worktree 隔离');
    }
    const dependencyContext = this.confirmedSources(context, args.dependsOnTaskIds);
    if (!dependencyContext.ok) return AgentToolResult.error(dependencyContext.error);
    const verificationContext = this.verificationCandidate(context, role, args.verifiesTaskId);
    if (!verificationContext.ok) return AgentToolResult.error(verificationContext.error);
    if (verificationContext.taskId && String(args.isolation || 'none').trim() === 'worktree') {
      return AgentToolResult.error('核验任务必须读取待核验任务的原工作树，不能再切到另一个 isolation=worktree');
    }
    /**
     * #18：模型自选的 `taskId` 是**任务身份**，不是可以反复使用的标签。
     * 此前 `String(args.taskId || makeTaskId())` 无条件写入，同 id 会静默**覆盖**已有任务视图：
     * 旧子代理还在跑却查不到（`get_subagent_task`/`cancel_subagent_task` 只能看到最新的那个），
     * 旧任务结束时回写又把新任务的视图盖回去。冲突一律显式拒绝，让模型换个 id 或省略由系统生成。
     */
    const requestedTaskId = String(args.taskId || '').trim();
    if (requestedTaskId && this.tasks.has(requestedTaskId)) {
      return AgentToolResult.error(
        'taskId 已被占用：' +
          requestedTaskId +
          '（每个子代理任务必须有唯一 id，不能复用已有的；省略 taskId 会自动生成一个新的）'
      );
    }

    const totalMs = clampTotalTimeout(args.timeoutSeconds, this.subCfg.totalTimeoutSeconds);
    const controller = lifecycle.controller;
    const task = {
      taskId: requestedTaskId || makeTaskId(),
      executionId: lifecycle.task.executionId,
      queuedAt: lifecycle.task.queuedAt,
      deadline: lifecycle.task.deadline,
      runId: this.runId,
      role,
      objective,
      inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {},
      dependsOnTaskIds: dependencyContext.taskIds,
      confirmedSources: dependencyContext.sources,
      verifiesTaskId: verificationContext.taskId || '',
      verificationCandidateDigest: verificationContext.resultDigest || '',
      verificationCandidate: verificationContext.candidate,
      verificationRoot: verificationContext.artifactRoot || '',
      review: { status: 'pending' },
      acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria.map(String) : [],
      stageNodeId: String(args.stageNodeId || ''),
      totalTimeoutMs: totalMs,
      maxTurns: Number.isInteger(args.maxTurns) && args.maxTurns > 0
        ? Math.min(200, args.maxTurns, Number(this.cfg.limits && this.cfg.limits.maxToolIterations) || 12)
        : Number(this.cfg.limits && this.cfg.limits.maxToolIterations) || 12,
      tokenBudget: Number.isInteger(args.tokenBudget) && args.tokenBudget > 0
        ? Math.min(4000000, args.tokenBudget, Number(this.subCfg.maxTotalTokens) > 0 ? Number(this.subCfg.maxTotalTokens) : 4000000)
        : Number(this.subCfg.maxTotalTokens) || 0,
      status: 'queued',
      version: lifecycle.task.version || 0,
      startedAt: new Date().toISOString(),
      controller,
    };
    transitionTask(task, 'running');
    // 先持久化任务身份再执行：进程中断后能识别哪些子任务的结果未知。
    try {
      if (context.projectRoot()) this.persistTask(context, task);
    } catch (error) {
      return AgentToolResult.error('子代理任务登记失败，未开始执行：' + String((error && error.message) || error).slice(0, 200));
    }
    // 计数与登记都在首个 await 前完成，并发批量不能绕过总配额。
    this.startedTaskCount += 1;
    this.tasks.set(task.taskId, task);
    context.audit(JSON.stringify({ kind: 'subagent_start', runId: this.runId, taskId: task.taskId, role, totalTimeoutMs: totalMs }));
    /**
     * 工作树隔离（对照文档 §5 #7）：isolation=worktree 时给这个子代理单独建一份 git 工作树，
     * 它在里面改项目文件；共享画布写工具在 childRegistry 里禁用，避免隔离声明掩盖全局副作用。
     * 建不出来就**中止任务**——绝不静默降级成「共享工作树」（那是最坏的失败方式：
     * 用户以为隔离了、实际上两个代理在同一个目录互相踩）。
     */
    /** @type {any} */
    let worktreeInfo = null;
    if (String(args.isolation || 'none').trim() === 'worktree') {
      const created = await worktreeLib.createWorktree(
        context.projectRoot(),
        { name: task.taskId },
        { context, policy: typeof context.sandbox === 'function' ? context.sandbox() : null }
      );
      if (!created.ok) {
        task.outcomeStatus = 'failed';
        task.error = '隔离工作树创建失败（' + created.error + '）：' + created.message;
        task.finishedAt = new Date().toISOString();
        context.audit(JSON.stringify({ kind: 'subagent_worktree_failed', taskId: task.taskId, error: created.error }));
        await this.updateStage(context, task, 'failed', task.error);
        return AgentToolResult.error(
          task.error + '\n已中止该子代理任务，未执行任何操作（不会静默降级成非隔离执行）。可以改用 isolation=none 显式共享工作树。',
          { taskId: task.taskId, isolation: 'worktree', error: created.error }
        );
      }
      worktreeInfo = { path: created.path, relativePath: created.relativePath, branch: created.branch, base: created.base };
      task.worktree = worktreeInfo;
      context.audit(JSON.stringify({ kind: 'subagent_worktree', taskId: task.taskId, path: created.relativePath, branch: created.branch, base: created.base }));
    }
    // 产物哈希必须按实际执行目录计算；隔离工作树里的改动不能拿主工作树的同名旧文件冒充。
    task.artifactRoot = task.verificationRoot || (worktreeInfo ? worktreeInfo.path : context.projectRoot());

    await this.updateStage(context, task, 'running', '子代理 ' + role + ' 正在执行' + (worktreeInfo ? '（隔离工作树 ' + worktreeInfo.relativePath + '）' : ''));

    // 总时长预算：组合父信号 + 自己的定时器。
    // 注意定时器**不能 unref** —— 被 unref 的 timer 不维持事件循环，被测/被中止场景下
    // 超时分支可能永不执行（S3 踩过同一个坑）。
    // 排队、准备工作树与执行共用同一个截止时间和取消控制器。

    let result = null;
    try {
      if (controller.signal.aborted) throw new Error('子任务已请求取消，未调用模型');
      const childRegistry = this.toolkit.buildDefaultRegistryWithConfig({
        ...this.cfg.tools,
        ragEnabled: this.cfg.rag.enabled && !!context.projectRoot(),
        // 子代理与父口径一致：配了 web_search 就一起可用（能力不该在子代理里静默消失）
        webSearchEnabled: parseWebSearchConfig(this.cfg).enabled,
        role,
        // 与父共享同一份租约账本（跨子代理的「单一写者」就靠它）
        leases: this.leases,
      });
      // worktree 只隔离文件；禁用 builder 的共享画布写工具，避免“隔离”任务仍改到父任务的 GraphModel。
      if (worktreeInfo) childRegistry.unregister('workbench_edit');
      const childContext = context.fork({
        runId: this.runId,
        taskId: task.taskId,
        role,
        readOnly: roles.isReadOnlyRole(role),
        signal: controller.signal,
        // 隔离：子代理的工具全部以工作树为 projectRoot（读写都落在独立检出里）
        projectRoot: worktreeInfo ? worktreeInfo.path : task.verificationRoot || undefined,
      });
      // 独立配额（父子链）：0 = 不设独立配额，直接共享父预算（旧行为）
      const childBudget = createSubagentBudget(this.cfg.requestBudget, task.tokenBudget);
      /**
       * #6（成本双重记账）：子代理的每一轮 `runAgentChat` 都会**自己**记账
       * （`recordCost` 按 `cfg.costKind` 归因，见 agent.cjs）。所以这里必须显式声明
       * `costKind:'subagent'`：否则逐轮会被记成 `main`（污染主模型口径），而外层的汇总记一次
       * 又会把同一笔用量记第二遍 —— 账本 `summary()/today()/byKind` 与 run 成本告警约 2 倍失真。
       */
      const childCfg = {
        ...this.cfg,
        costKind: 'subagent',
        subagentBudgetState: null,
        modelTaskType: 'subagent',
        traceContext: typeof childContext.traceContext === 'function' ? childContext.traceContext() : this.cfg.traceContext,
        traceProjectRoot: this.cfg.traceProjectRoot || context.projectRoot(),
        limits: { ...(this.cfg.limits || {}), maxToolIterations: task.maxTurns },
        ...(childBudget && childBudget !== this.cfg.requestBudget ? { requestBudget: childBudget } : {}),
      };
      childContext.modelRuntimeValue = { budget: childCfg.requestBudget,
        queue: require('./requestQueue.cjs').modelQueue, prices: childCfg.costPrices,
        traceContext: childCfg.traceContext, traceProjectRoot: childCfg.traceProjectRoot,
        onUsage: (entry) => this.agent.recordCost(childCfg, entry) };
      // 子代理的 system prompt：身份 + 工作范围 + **真实注册表里的**可用工具 + 职责技能 + 项目 Skill + 运行规则。
      // 工具清单取自 childRegistry（不是手写名单），永远不会与角色权限裁剪漂移。
      const childTools = childRegistry.listTools().map((spec) => ({ name: spec.name, description: spec.description }));
      const systemPrompt = subagentPrompt.buildSubagentPrompt(task, {
        role,
        tools: childTools,
        projectSkills: this.readProjectSkills(context.projectRoot()),
        confirmedSources: task.confirmedSources,
        verificationCandidate: task.verificationCandidate,
      });
      result = await this.agent.runAgentChat({
        cfg: childCfg,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: objective },
        ],
        tools: { registry: childRegistry, context: childContext },
        signal: controller.signal,
        timeoutMs: Math.min(MAX_SINGLE_TURN_TIMEOUT_MS, totalMs),
        onDelta: (event) => this.onDelta && this.onDelta({ kind: 'subagent_delta', taskId: task.taskId, role, event }),
      });
      task.toolCalls = result.toolCalls || [];
      task.grounding = result.grounding || null;
      task.usage = result.usage || null;
      task.summary = String(result.content || '');
      // #5：把主循环的收尾原因如实带出来 —— 信封据此判定「这是不是完整结论」
      task.stopReason = result.stopReason || null;
      task.finishReason = result.finishReason || null;
      if (lifecycle.timedOut) {
        task.outcomeStatus = 'blocked';
        task.error = '子代理任务达到总时长上限（约 ' + Math.round(totalMs / 1000) + 's），已中止';
      } else if (result.error) {
        task.outcomeStatus = 'failed';
        task.error = String(result.error);
      } else if (result.aborted) {
        if (task.cancelRequested) {
          // 第 6 项：主动取消要如实说清是「被谁取消的」，而不是统一报成「信号中断」
          task.outcomeStatus = 'cancelled';
          task.error = '子代理任务被主动取消：' + (task.cancelReason || '未说明原因') + '（已提交的写操作不会回滚）';
        } else {
          task.outcomeStatus = 'blocked';
          task.error = '子代理被取消（主 Agent 停止或信号中断）';
        }
      } else if (result.stopReason) {
        /**
         * #5（P1 信任放大）：此前这里只看 `timedOut`/`error`/`aborted`，**从不读 `stopReason`**。
         * 而 `finish_reason=length` 且续写补问用尽时，主循环返回 `{stopReason:'length_truncated'}`
         * 且**不设 error** —— 于是半截报告被标成 `done`，还产出一个「契约合规」的信封，
         * 主代理拿它当完整证据。截断/未自然结束 = 未完成：状态必须离开 done，
         * 信封才会是 `kind:'error'`（见 subagentEnvelope.buildEnvelope）。
         */
        task.outcomeStatus = 'failed';
        task.error =
          result.stopReason === 'length_truncated'
            ? '子代理输出被 max_tokens 截断（finish_reason=length，续写补问已用尽），返回的是**半截内容**：' +
              '不得当作完整结论采信。请缩小 objective 的范围、分段委派，或提高该模型的 max_tokens 后重做。'
            : '子代理未自然结束（stopReason=' + String(result.stopReason) + '）：结果不完整，不得当作完整结论采信。';
      } else {
        task.outcomeStatus = 'done';
      }
      // #6（成本双重记账）：这里**不再**用 result.usage（逐轮 mergeUsage 的累加值）汇总记第二次账 ——
      // 子代理每一轮已按 childCfg.costKind='subagent' 在 agent.cjs 里如实记过一条，再记一次就是同一笔用量的第二份。
      // task.usage 仍保留（信封与 taskView 需要它展示真实消耗）。
    } catch (error) {
      task.outcomeStatus = lifecycle.timedOut ? 'blocked' : 'failed';
      task.error = lifecycle.timedOut
        ? '子代理任务达到总时长上限（约 ' + Math.round(totalMs / 1000) + 's），已中止'
        : String(error && error.message ? error.message : error);
    } finally {
      task.controller = null; // 释放取消引用（任务已结束）
    }

    task.finishedAt = new Date().toISOString();
    this.tasks.set(task.taskId, task);
    // 任务结束（成功/失败都算）→ 释放它持有的全部资源租约。
    // 释放点放在这里而不是「每次写完」：写完就放，另一个 Agent 会基于过期的读去覆盖（丢更新）。
    // 租约与并发槽统一由 delegate 的 finally 释放，包含准备/信封阶段抛错的路径。

    /**
     * 隔离工作树的收尾统计：数出「改了什么、提交了几个」，供主代理决定合并还是移除。
     * **不自动合并** —— 工作树的价值就是「主代理的工作树不受影响」，合并是主代理看过 diff 之后的决定。
     */
    if (worktreeInfo) {
      const hopts = { context, policy: typeof context.sandbox === 'function' ? context.sandbox() : null };
      const changedList = await worktreeLib.changedFiles(worktreeInfo.path, hopts);
      worktreeInfo.changed = changedList.map((c) => c.status + ' ' + c.path);
      worktreeInfo.commits = await worktreeLib.commitCount(worktreeInfo.path, worktreeInfo.base, hopts);
      worktreeInfo.sourceSnapshot = await worktreeLib.snapshotSource(worktreeInfo.path, hopts);
      task.worktree = worktreeInfo;
      context.audit(
        JSON.stringify({ kind: 'subagent_worktree_summary', taskId: task.taskId, changed: worktreeInfo.changed.length, commits: worktreeInfo.commits })
      );
    }

    const body = task.outcomeStatus === 'done' ? (task.summary || '（子代理未返回文本）') : (task.error || '子代理任务未完成');
    const cap = this.subCfg.resultMaxChars;
    const clipped = body.length > cap;
    const summaryText = clipped ? body.slice(0, cap) : body;
    // 单一 JSON 信封（P1）：字段齐全、带世界状态快照、产物真实哈希、截断自报 lossy。
    // 契约违约 → 下面的工具结果会是 error（**拒收**），主代理不得把它的结论当证据。
    const built = subagentEnvelope.buildEnvelope({
      task: { ...task, status: task.outcomeStatus },
      projectRoot: task.artifactRoot || context.projectRoot(),
      model: typeof context.model === 'function' ? context.model() : null,
      inReplyTo: task.parentToolCallId || null,
      changedFiles: changedFiles(task.toolCalls),
      summary: task.outcomeStatus === 'done' ? summaryText : '',
      error: task.outcomeStatus === 'done' ? '' : summaryText,
      clipped: clipped ? { droppedChars: body.length - cap } : null,
    });
    task.envelope = built.envelope;
    if (task.outcomeStatus === 'done' && !built.violations.length) {
      if (task.review && task.review.status === 'needs_recheck') {
        task.review = { ...task.review, resultProducedAt: task.finishedAt || new Date().toISOString() };
      } else {
        task.review = { status: 'candidate', candidateAt: task.finishedAt || new Date().toISOString() };
      }
    } else {
      task.review = { status: 'not_eligible', reason: task.error || '任务未成功完成' };
    }
    // view 必须在信封建好之后再取：view.envelope 要带上它（回放不改哈希）
    const view = taskView({ ...task, status: task.outcomeStatus });
    // §4.2：任务结束即落盘（跨 run 可查）—— 此前只有进程内 Map + 两行 delta，重启即失忆
    // 终态落盘由 delegate 集中完成，避免信封未验收时提前展示 done。
    const text =
      subagentEnvelope.renderEnvelopeText(built.envelope, built.violations) +
      (worktreeInfo ? '\n\n' + renderWorktreeSummary(worktreeInfo) : '');
    const modelContent = renderTaskModelCard(view);
    if (built.violations.length) {
      // 拒收：契约不完整的结果**不能**当结论用（这正是「信任放大」的闸门）
      context.audit(
        JSON.stringify({
          kind: 'subagent_envelope_rejected',
          taskId: task.taskId,
          violations: built.violations.map((v) => v.path + ': ' + v.message),
        })
      );
      return AgentToolResult.error(
        text + '\n（该结果已被契约校验**拒收**：缺字段/缺快照/无结论的结果不得作为证据。可按上面的违约项让子代理重做，或由主代理直接完成这一步。）',
        view,
        { modelContent: modelContent + '\n该信封已被契约校验拒收，不得作为证据。' }
      );
    }
    return task.outcomeStatus === 'done'
      ? AgentToolResult.ok(text, view, { modelContent })
      : AgentToolResult.error(
          text + '\n请勿用相同 objective 原样重试（同参数会再执行一次）：先按上面的原因缩小范围或换角色（只读探查用 explorer、验证用 verifier），或由主代理直接完成这一步。',
          view,
          { modelContent: modelContent + '\n请勿原样重试；先处理失败原因。' }
        );
  }

  /**
   * 回写绑定的 stage 节点。
   * S9：先校验节点存在与类型，再看 registry 的返回值 —— 之前这里静默忽略失败，
   * 画布上「子代理痕迹消失」没有任何提示。
   */
  async updateStage(context, task, status, summary) {
    if (!task.stageNodeId || !this.registry) return null;
    try {
      const model = context && typeof context.model === 'function' ? context.model() : null;
      const node = model && typeof model.byId === 'function' ? model.byId(task.stageNodeId) : null;
      if (model && typeof model.byId === 'function' && !node) {
        task.stageWarning = 'stage 节点不存在：' + task.stageNodeId + '（子代理结果未回写画布）';
        context.audit(JSON.stringify({ kind: 'subagent_stage_missing', taskId: task.taskId, stageNodeId: task.stageNodeId }));
        return null;
      }
      if (node && node.type && node.type !== 'stage') {
        task.stageWarning = '绑定的节点不是 stage 类型（' + node.type + '）：状态仍会写入，但语义可能不符';
        context.audit(JSON.stringify({ kind: 'subagent_stage_type_mismatch', taskId: task.taskId, stageNodeId: task.stageNodeId, type: node.type }));
      }
    } catch {}
    const res = await this.registry.execute(
      'workbench_edit',
      {
        operations: [
          { action: 'set_status', nodeId: task.stageNodeId, value: status },
          { action: 'set_result_summary', nodeId: task.stageNodeId, value: summary },
        ],
      },
      context
    );
    if (!res || res.ok !== true) {
      task.stageWarning = '画布回写失败：' + String((res && res.text) || '未知原因');
      context.audit(JSON.stringify({ kind: 'subagent_stage_update_failed', taskId: task.taskId, stageNodeId: task.stageNodeId, error: String((res && res.text) || '').slice(0, 300) }));
    }
    return res;
  }
}

module.exports = { SubagentManager, READ_ONLY_ROLES, ROLE_PROMPTS, changedFiles, taskView, clampTotalTimeout, DEFAULTS, persistTaskView, readTaskViews, listTaskViews, subagentViewFile };
