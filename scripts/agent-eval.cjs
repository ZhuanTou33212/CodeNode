#!/usr/bin/env node
/**
 * CodeNode Agent 真实多步评测 runner
 *
 * 目的：补上「真实多步工具任务 / 修改后跑测试 / 检索引用 / 长上下文压缩 / 提示注入 / 取消 /
 *       崩溃恢复 / 预算上限」的端到端评测，并用工作台真实终态判定，而不是只看模型自述。
 *
 * 两种模式：
 *   offline（默认，无网络、确定性）
 *     在 fetch 传输边界注入「脚本化 chat 客户端」：agent.runAgentChat → chatCompletionStream → fetch
 *     这条真实链路全部走通（工具循环、只读缓存、子代理压缩、取消、预算、runStore 事件），
 *     只有模型返回是可复现的脚本。工具、文件系统、shell、Run JSONL 都是真跑。
 *   model（真实模型，需显式配置）
 *     仅当设置了 CODENODE_EVAL_API_KEY 才启用；未配置时该模式显式 skipped，且以非 0 退出（fail-closed），
 *     不允许「无 Key 静默假绿」。真实模型模式只跑任务集里标记 realModel === true 的任务。
 *
 * 用法：
 *   node scripts/agent-eval.cjs                        # 离线全量
 *   node scripts/agent-eval.cjs --task=cancel-mid-run  # 只跑一个任务
 *   node scripts/agent-eval.cjs --keep                 # 保留临时工作区便于排查
 *   node scripts/agent-eval.cjs --mode=model --require-model
 *
 * 退出码：
 *   0  全部必需任务通过（模型模式未被要求时不适用）
 *   1  有必需任务失败 / 评测自身自检失败
 *   2  真实模型模式缺少必需凭据（fail-closed）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const agent = require('../electron/agent.cjs');
const runStore = require('../electron/runStore.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { getScalarStore } = require('../electron/scalars/index.cjs');
const { datasetVersion, tasks: TASKS } = require('./agent-eval-tasks.cjs');

const EXIT_OK = 0;
const EXIT_TASK_FAIL = 1;
const EXIT_MODEL_UNCONFIGURED = 2;

const DEFAULT_USAGE = { total_tokens: 120, prompt_tokens: 80, completion_tokens: 40 };
const WORKSPACE_IGNORE = ['.codenode', 'node_modules'];
const REPORT_DIR_REL = path.join('docs', 'eval-reports');

/* ------------------------------- 参数解析 ------------------------------- */

function parseArgs(argv) {
  const opts = { mode: 'offline', requireModel: false, allowModelSkip: false, keep: false, tasks: [], json: false, reportDir: null };
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--mode=offline') opts.mode = 'offline';
    else if (arg === '--mode=model') opts.mode = 'model';
    else if (arg.startsWith('--mode=')) throw new Error('未知 --mode：' + arg);
    else if (arg === '--require-model') opts.requireModel = true;
    else if (arg === '--allow-model-skip') opts.allowModelSkip = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--list') opts.list = true;
    else if (arg.startsWith('--task=')) opts.tasks.push(arg.slice('--task='.length));
    else if (arg.startsWith('--report-dir=')) opts.reportDir = arg.slice('--report-dir='.length);
    else throw new Error('未知参数：' + arg);
  }
  return opts;
}

/* ------------------------------- 小工具 ------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function gitInfo() {
  const run = (args) => {
    try {
      const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
      return res.status === 0 ? String(res.stdout || '').trim() : '';
    } catch {
      return '';
    }
  };
  return {
    commit: run(['rev-parse', '--short', 'HEAD']) || 'nogit',
    fullCommit: run(['rev-parse', 'HEAD']) || 'nogit',
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'nogit',
    dirty: !!run(['status', '--porcelain']),
  };
}

/** 从工作台源码里取硬上限常量，报告里的参数必须来自真实代码而不是复述文档。 */
function sourceLimits() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'agent.cjs'), 'utf8');
    const iter = src.match(/MAX_TOOL_ITERATIONS\s*=\s*(\d+)/);
    const calls = src.match(/MAX_TOTAL_TOOL_CALLS\s*=\s*(\d+)/);
    return {
      maxToolIterations: iter ? Number(iter[1]) : null,
      maxTotalToolCalls: calls ? Number(calls[1]) : null,
      source: 'electron/agent.cjs',
    };
  } catch {
    return { maxToolIterations: null, maxTotalToolCalls: null, source: null };
  }
}

function listFiles(root, relative = '') {
  const out = [];
  const dir = path.join(root, relative);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relative ? relative + '/' + entry.name : entry.name;
    if (WORKSPACE_IGNORE.includes(entry.name)) continue;
    if (entry.name.endsWith('.bak')) continue;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function snapshotWorkspace(root) {
  const files = {};
  for (const rel of listFiles(root)) {
    try {
      files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      files[rel] = '<binary>';
    }
  }
  return files;
}

function diffWorkspace(before, after) {
  const changed = [];
  for (const [rel, content] of Object.entries(after)) {
    if (!(rel in before)) changed.push(rel + ' (新建)');
    else if (before[rel] !== content) changed.push(rel + ' (修改)');
  }
  for (const rel of Object.keys(before)) if (!(rel in after)) changed.push(rel + ' (删除)');
  return changed.sort();
}

/* --------------------------- 脚本化 chat 客户端 --------------------------- */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
}

function sse(data) {
  return 'data: ' + JSON.stringify(data) + '\n\n';
}

function toolCallsDelta(calls) {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id || 'call_' + index,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
          })),
        },
      },
    ],
  };
}

function sseForStep(step, usage) {
  let out = '';
  if (step.tools && step.tools.length) {
    out += sse(toolCallsDelta(step.tools));
  } else if (step.tool) {
    out += sse(toolCallsDelta([{ name: step.tool, args: step.args }]));
  } else {
    out += sse({ choices: [{ index: 0, delta: { content: String(step.content || '（无内容）') } }] });
  }
  out += sse({ choices: [], usage });
  out += 'data: [DONE]\n\n';
  return out;
}

function describeStep(step) {
  if (step.tools) return step.tools.map((t) => t.name).join('+');
  if (step.tool) return step.tool;
  return 'content';
}

/**
 * 脚本化传输：替换 global.fetch。
 * - body.stream === true  → 主循环的一步（按 script 顺序回放）
 * - body.stream !== true  → 子代理压缩等非流式调用（返回确定性摘要，不消耗 script 步数）
 * 任何非评测目标的网络地址都会被记录为 unexpected（用于「离线模式没有真实联网」自检）。
 */
function createScriptedTransport(/** @type {{ task: any, apiBase: string, onStep?: Function }} */ { task, apiBase, onStep }) {
  const usage = { ...DEFAULT_USAGE, ...(task.usage || {}) };
  const stats = { streamRequests: 0, nonStreamRequests: 0, unexpectedUrls: [], steps: [], exhausted: 0 };
  let mainStep = 0;

  async function fetchImpl(url, init) {
    const urlStr = typeof url === 'string' ? url : String(url && url.url ? url.url : url);
    if (!urlStr.startsWith(apiBase)) {
      stats.unexpectedUrls.push(urlStr);
      return jsonResponse({ error: '离线评测模式禁止访问：' + urlStr }, 403);
    }
    let body = {};
    try {
      body = JSON.parse((init && init.body) || '{}');
    } catch {}
    if (!body.stream) {
      stats.nonStreamRequests++;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userMsg = messages.find((m) => m.role === 'user') || { content: '' };
      const raw = String(userMsg.content || '');
      const summary = '【脚本压缩】原始 ' + raw.length + ' 字符 → 保留要点：\n' + raw.slice(0, 90);
      return jsonResponse({ choices: [{ message: { content: summary } }], usage });
    }
    stats.streamRequests++;
    const step = task.script[mainStep];
    mainStep++;
    if (!step) {
      stats.exhausted++;
      stats.steps.push('script-exhausted');
      return sseResponse(sse({ choices: [{ index: 0, delta: { content: '（脚本已耗尽，评测脚本回合不足）' } }] }) + sse({ choices: [], usage }) + 'data: [DONE]\n\n');
    }
    stats.steps.push(describeStep(step));
    if (onStep) onStep({ index: mainStep, step, stats });
    if (step.error) return jsonResponse({ error: step.error }, 500);
    return sseResponse(sseForStep(step, usage));
  }

  return { fetchImpl, stats };
}

/* ------------------------------ 引用占位符 ------------------------------ */

function collectCitations(records) {
  const out = [];
  for (const record of records) {
    if (record.name !== 'retrieve_context') continue;
    const sources = (record.data && Array.isArray(record.data.sources) && record.data.sources) || [];
    for (const source of sources) {
      if (source && source.citation) out.push(String(source.citation));
    }
  }
  return out;
}

function interpolate(text, citations) {
  const fileOnes = citations.filter((c) => !c.startsWith('scalar:'));
  return String(text == null ? '' : text).replace(/\{\{source(?::(\d+))?\}\}/g, (_m, idx) => {
    const list = fileOnes.length ? fileOnes : citations;
    const i = idx == null ? 0 : Number(idx);
    return list[i] || '（无可用来源）';
  });
}

/* -------------------------------- 断言检查 -------------------------------- */

/**
 * 每个检查函数返回 { pass, detail }。
 * 全部基于「工作台真实终态」：文件字节 / 工具层返回 / Run JSONL / 独立复跑退出码。
 */
function buildChecks(ctx) {
  const records = () => ctx.result.toolCalls || [];
  const byTool = (name) => records().filter((r) => r.name === name);
  const workspacePath = (rel) => path.resolve(ctx.workspace, rel);

  return {
    'registry-excludes': (check) => ({
      pass: !ctx.registry.contains(check.tool),
      detail: `工具注册表 ${ctx.registry.contains(check.tool) ? '仍包含' : '已排除'} ${check.tool}`,
    }),
    'registry-includes': (check) => ({
      pass: ctx.registry.contains(check.tool),
      detail: `工具注册表 ${ctx.registry.contains(check.tool) ? '包含' : '缺少'} ${check.tool}`,
    }),
    'tool-ok': (check) => {
      const hit = byTool(check.tool).filter((r) => r.ok);
      return { pass: hit.length >= (check.min || 1), detail: `${check.tool} 成功调用 ${hit.length} 次` };
    },
    'tool-failed': (check) => {
      const hit = byTool(check.tool).filter((r) => !r.ok);
      return { pass: hit.length >= (check.min || 1), detail: `${check.tool} 失败调用 ${hit.length} 次（期望 ≥${check.min || 1}）` };
    },
    'tool-called': (check) => {
      const n = byTool(check.tool).length;
      const min = check.min == null ? 1 : check.min;
      const max = check.max == null ? Infinity : check.max;
      return { pass: n >= min && n <= max, detail: `${check.tool} 调用次数 ${n}（期望 ${min}..${max}）` };
    },
    'tool-not-called': (check) => {
      const n = byTool(check.tool).length;
      return { pass: n === 0, detail: `${check.tool} 调用次数 ${n}（期望 0）` };
    },
    'tool-data-match': (check) => {
      const hit = byTool(check.tool).filter((r) => r.data && r.data[check.key] === check.value);
      return { pass: hit.length > 0, detail: `${check.tool}.data.${check.key} === ${JSON.stringify(check.value)} 命中 ${hit.length} 次` };
    },
    'tool-result-contains': (check) => {
      const hit = byTool(check.tool).filter((r) => String(r.result || '').includes(check.text));
      return { pass: hit.length > 0, detail: `${check.tool} 返回文本包含「${check.text}」${hit.length ? '是' : '否'}` };
    },
    'tool-results-not-contains': (check) => {
      const hit = records().filter((r) => String(r.result || '').includes(check.text));
      return { pass: hit.length === 0, detail: `工具返回中「${check.text}」出现 ${hit.length} 次（期望 0）` };
    },
    'file-exists': (check) => ({ pass: fs.existsSync(workspacePath(check.path)), detail: `${check.path} 存在=${fs.existsSync(workspacePath(check.path))}` }),
    'file-missing': (check) => ({ pass: !fs.existsSync(workspacePath(check.path)), detail: `${check.path} 存在=${fs.existsSync(workspacePath(check.path))}（期望不存在）` }),
    'file-contains': (check) => {
      let content = null;
      try {
        content = fs.readFileSync(workspacePath(check.path), 'utf8');
      } catch {}
      const ok = content != null && content.includes(check.text);
      return { pass: ok, detail: `${check.path} 包含「${check.text}」=${ok}` };
    },
    'file-not-contains': (check) => {
      let content = null;
      try {
        content = fs.readFileSync(workspacePath(check.path), 'utf8');
      } catch {}
      const ok = content != null && !content.includes(check.text);
      return { pass: ok, detail: `${check.path} 仍含「${check.text}」=${content != null && content.includes(check.text)}（期望否）` };
    },
    'path-missing': (check) => {
      const full = path.resolve(ctx.workspace, check.path);
      return { pass: !fs.existsSync(full), detail: `${full} 存在=${fs.existsSync(full)}（期望不存在）` };
    },
    'workspace-changes': (check) => {
      const changed = diffWorkspace(ctx.before, ctx.after);
      const expect = (check.expect || []).slice().sort();
      const normalize = (list) => list.map((item) => String(item).replace(/\s*\((新建|修改|删除)\)$/, '')).sort();
      const ok = JSON.stringify(normalize(changed)) === JSON.stringify(normalize(expect));
      return { pass: ok, detail: `工作区变更=[${changed.join(', ') || '无'}] 期望=[${expect.join(', ') || '无'}]` };
    },
    'steps-at-most': (check) => ({
      pass: ctx.modelSteps <= check.max,
      detail: `模型步数 ${ctx.modelSteps} ≤ ${check.max}`,
    }),
    'delta-kind': (check) => {
      const n = ctx.deltas.filter((d) => d && d.kind === check.kind).length;
      return { pass: n >= (check.min || 1), detail: `onDelta kind=${check.kind} 出现 ${n} 次（期望 ≥${check.min || 1}）` };
    },
    compressed: (check) => {
      const hit = byTool(check.tool).filter((r) => r.compressed);
      return { pass: hit.length >= (check.min || 1), detail: `${check.tool} 触发子代理压缩 ${hit.length} 次（期望 ≥${check.min || 1}）` };
    },
    'compressed-ratio': (check) => {
      const hit = byTool(check.tool).filter((r) => r.compressedChars && r.compressedChars.from > 0);
      if (!hit.length) return { pass: false, detail: `${check.tool} 没有压缩记录` };
      const worst = Math.max(...hit.map((r) => r.compressedChars.to / r.compressedChars.from));
      return { pass: worst <= check.maxRatio, detail: `压缩后/前 最大比 ${worst.toFixed(3)}（期望 ≤${check.maxRatio}）` };
    },
    'context-bounded': (check) => {
      const nonSystem = ctx.messages.filter((m) => m.role !== 'system');
      const longest = nonSystem.reduce((max, m) => Math.max(max, String(m.content || '').length), 0);
      return { pass: longest <= check.maxChars, detail: `上下文中最长非 system 消息 ${longest} 字符（上限 ${check.maxChars}）` };
    },
    'citation-source': (check) => {
      const pattern = new RegExp(check.pattern);
      const hits = ctx.citations.filter((c) => pattern.test(c));
      return { pass: hits.length >= (check.min || 1), detail: `召回文件引用 ${hits.length} 条（期望 ≥${check.min || 1}）：${hits.slice(0, 3).join(' | ')}` };
    },
    'grounding-status': (check) => {
      const text = interpolate(check.use, ctx.citations);
      const grounding = agent.validateRagGrounding(text, records());
      return { pass: grounding.status === check.expect, detail: `引用校验 status=${grounding.status}（期望 ${check.expect}），文本片段「${text.slice(0, 80)}」` };
    },
    'error-contains': (check) => ({
      pass: String(ctx.result.error || '').includes(check.text),
      detail: `result.error=${JSON.stringify(String(ctx.result.error || '').slice(0, 160))} 含「${check.text}」=${String(ctx.result.error || '').includes(check.text)}`,
    }),
    'stop-reason': (check) => ({ pass: ctx.result.stopReason === check.value, detail: `stopReason=${ctx.result.stopReason}（期望 ${check.value}）` }),
    aborted: (check) => ({ pass: !!ctx.result.aborted === check.value, detail: `aborted=${!!ctx.result.aborted}（期望 ${check.value}）` }),
    'run-status': (check) => {
      const status = runStore.summarizeRun(runStore.readRun(ctx.workspace, ctx.runId)).status;
      return { pass: status === check.value, detail: `Run 状态=${status}（期望 ${check.value}）` };
    },
    'run-event': (check) => {
      const events = runStore.readRun(ctx.workspace, ctx.runId).filter((e) => e.type === check.event);
      const min = check.min == null ? 0 : check.min;
      const max = check.max == null ? Infinity : check.max;
      return { pass: events.length >= min && events.length <= max, detail: `Run 事件 ${check.event} 共 ${events.length} 条（期望 ${min}..${max}）` };
    },
    'crash-recovery': (check) => {
      // 只读断言：崩溃留下的 Run 事件 → 恢复扫描 → 续跑计划 → 重试标记，全部走 runStore 真实接口
      const recovered = runStore.recoverInterrupted(ctx.workspace);
      const recoveredEvents = runStore.readRun(ctx.workspace, ctx.runId).filter((e) => e.type === 'run_recovered').length;
      const plan = runStore.resumePlan(ctx.workspace, ctx.runId);
      const toolNames = (plan.completedToolNames || []).slice();
      const replacement = 'eval-replacement-' + Date.now().toString(36);
      const retry = runStore.markRetry(ctx.workspace, ctx.runId, replacement);
      const statusAfter = runStore.summarizeRun(runStore.readRun(ctx.workspace, ctx.runId)).status;
      const missing = (check.expectToolNames || []).filter((name) => !toolNames.includes(name));
      const pass =
        recovered.length === check.expectRecovered &&
        recoveredEvents >= 1 &&
        plan.ok === check.expectResumePlan &&
        plan.requiresReview === true &&
        missing.length === 0 &&
        retry.ok === true &&
        statusAfter === 'superseded';
      return {
        pass,
        detail:
          `恢复扫描恢复 ${recovered.length} 个 Run（期望 ${check.expectRecovered}）；run_recovered=${recoveredEvents}；` +
          `resumePlan.ok=${plan.ok}；已完成工具=[${toolNames.join(', ')}]（缺 ${missing.join(', ') || '无'}）；` +
          `markRetry.ok=${retry.ok}；重试后状态=${statusAfter}`,
      };
    },
    'verify-shell': (check) => {
      // 评测进程独立复跑（不采信模型自述，也不只信工具返回）
      const res = spawnSync(check.command, { cwd: ctx.workspace, shell: true, encoding: 'utf8', timeout: check.timeoutMs || 60000 });
      const stdout = String(res.stdout || '');
      const ok = res.status === 0 && (!check.expect || stdout.includes(check.expect));
      return {
        pass: ok,
        detail: `独立复跑「${check.command}」exit=${res.status}，输出含「${check.expect}」=${stdout.includes(String(check.expect || ''))}；输出=${JSON.stringify(stdout.trim().slice(0, 120))}`,
      };
    },
  };
}

/* --------------------------------- 单任务 --------------------------------- */

function writeFixtures(workspace, fixture) {
  for (const [rel, content] of Object.entries(fixture || {})) {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(content), 'utf8');
  }
}

function buildConfig(task, workspace, mode, modelCfg) {
  const cfg = agent.loadConfig(workspace);
  const override = task.cfgOverride || {};
  cfg.apiBase = mode === 'model' ? modelCfg.apiBase : 'https://scripted.eval.local/v1';
  cfg.apiKey = mode === 'model' ? modelCfg.apiKey : 'scripted-eval-key';
  cfg.model = mode === 'model' ? modelCfg.model : 'scripted-eval/' + task.id;
  cfg.maxTokens = 4096;
  cfg.reasoningEffort = 'low';
  // 评测内重试固定为 1：脚本化传输的失败必须确定性可判定
  cfg.reliability = { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 };
  if (override.compression) cfg.compression = { ...cfg.compression, ...override.compression };
  if (task.budget && task.budget.maxTotalTokens) {
    cfg.limits = { ...cfg.limits, maxTotalTokens: task.budget.maxTotalTokens };
  }
  const RequestBudget = require('../electron/requestBudget.cjs').RequestBudget;
  cfg.requestBudget = new RequestBudget(task.requestBudgetTokens || cfg.limits.maxTotalTokens);
  return cfg;
}

async function runTask(task, opts) {
  const started = Date.now();
  const record = {
    id: task.id,
    title: task.title,
    category: task.category,
    required: task.required !== false,
    status: 'fail',
    reason: null,
    allowTools: task.allowTools,
    budget: task.budget,
    durationMs: 0,
    modelSteps: 0,
    toolCalls: 0,
    checks: [],
    failed: [],
  };

  if (opts.mode === 'model' && task.realModel !== true) {
    record.status = 'skipped';
    record.reason = '该任务依赖脚本化模型（确定性注入/预算/取消/崩溃），真实模型模式不适用';
    record.durationMs = Date.now() - started;
    return record;
  }

  const workspace = fs.mkdtempSync(path.join(opts.workRoot, 'eval-' + task.id + '-'));
  record.workspace = workspace;
  writeFixtures(workspace, task.fixture);
  const before = snapshotWorkspace(workspace);

  const cfg = buildConfig(task, workspace, opts.mode, opts.modelCfg);
  const registry = toolkit.buildDefaultRegistryWithConfig({
    toolsEnabled: true,
    toolsAllowed: task.allowTools,
    ragEnabled: true,
    projectRoot: workspace,
  });
  const model = new GraphModel();
  const controller = new AbortController();
  const runId = runStore.normalizeRunId('eval-' + task.id);
  const deltas = [];
  const messages = [];

  const context = new AgentToolContext({
    projectRoot: workspace,
    model,
    runId,
    role: 'supervisor',
    signal: controller.signal,
    scalarStore: getScalarStore(workspace),
    // 评测自动批准写操作：确认交互不属于本任务判据（路径边界/敏感文件由工具层独立拦截）
    confirm: async () => true,
    audit: (entry) => runStore.appendEvent(workspace, runId, 'audit', { entry: String(entry || '').slice(0, 2000) }),
    mutateWorkbench: async (fn) => {
      fn(model);
      return true;
    },
    saveProject: async () => null,
    askUser: async () => '',
    ui: async () => false,
    conversationHistory: () => [],
    notifyFileChange: () => {},
    ragConfig: cfg.rag,
  });

  const soul = agent.parseSoul(agent.loadSoul(cfg, workspace));
  const toolGuide = agent.buildToolGuide(registry.listTools());
  messages.push({ role: 'system', content: agent.buildSystemPrompt(soul, '', toolGuide, '', '') });
  messages.push({ role: 'user', content: task.prompt });

  let toolResultCount = 0;
  let crashed = false;
  let cancelArmed = !!task.cancelAfter;
  const onDelta = (delta) => {
    if (!delta || !delta.kind) return;
    deltas.push(delta);
    // 与 electron/main.cjs 的 agent:chat 保持一致：把本轮关键事件写进 Run JSONL
    if (delta.kind === 'tool_result' && Array.isArray(delta.toolCalls)) {
      runStore.appendEvent(workspace, runId, 'tool_result', {
        tools: delta.toolCalls.map((item) => ({ name: item && item.name, ok: item && item.ok, elapsedMs: item && item.elapsedMs })),
      });
      toolResultCount += delta.toolCalls.length;
      // 取消判据（离线模式）：第 N 次目标工具结果返回后取消运行
      if (cancelArmed && task.cancelAfter) {
        const matched = (task.cancelAfter.tool == null || delta.toolCalls.some((item) => item && item.name === task.cancelAfter.tool));
        if (matched && toolResultCount >= (task.cancelAfter.count || 1)) {
          cancelArmed = false;
          controller.abort();
        }
      }
      // 崩溃判据：到达既定工具结果数后中止且不写 run_finish（等同于进程被杀）
      if (task.simulateCrash && toolResultCount >= (task.crashAfterToolCall || 1)) {
        crashed = true;
        controller.abort();
      }
    } else if (['start', 'error', 'stopped', 'done'].includes(delta.kind)) {
      runStore.appendEvent(workspace, runId, delta.kind, { error: delta.error || null });
    }
  };

  let transport = null;
  let originalFetch = null;
  if (opts.mode === 'offline') {
    transport = createScriptedTransport({ task, apiBase: cfg.apiBase });
    originalFetch = global.fetch;
    global.fetch = transport.fetchImpl;
  }

  let timer = null;
  if (opts.mode === 'model' && task.cancelAfterMs) {
    timer = setTimeout(() => controller.abort(), task.cancelAfterMs);
  }

  runStore.startRun(workspace, runId, { prompt: String(task.prompt).slice(0, 4000), model: cfg.model });
  agent.logConversation(workspace, { ts: nowIso(), role: 'user', content: task.prompt, nodeId: null });

  let watchdogFired = false;
  const watchdogMs = (task.budget && task.budget.timeoutMs ? task.budget.timeoutMs : 60000) + 20000;
  const runPromise = agent
    .runAgentChat({
      cfg,
      messages,
      onDelta,
      tools: { registry, context },
      signal: controller.signal,
      timeoutMs: task.budget && task.budget.timeoutMs ? task.budget.timeoutMs : 60000,
    })
    .catch((error) => ({ error: String((error && error.message) || error), toolCalls: [], aborted: controller.signal.aborted }));

  let result = await Promise.race([
    runPromise,
    new Promise((resolve) =>
      setTimeout(() => {
        watchdogFired = true;
        controller.abort();
        resolve({ error: '评测看门狗超时（任务未在预算时间内结束）', toolCalls: [], aborted: true });
      }, watchdogMs)
    ),
  ]);
  if (watchdogFired) {
    // 给被取消的循环一点时间落盘事件，避免报告与磁盘状态不一致
    try {
      result = await Promise.race([runPromise, new Promise((resolve) => setTimeout(() => resolve(result), 3000))]);
    } catch {}
  }
  if (timer) clearTimeout(timer);
  if (transport) global.fetch = originalFetch;

  if (!crashed && !watchdogFired) {
    runStore.finishRun(workspace, runId, result.error ? 'error' : result.aborted ? 'cancelled' : 'completed', {
      toolCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
      usage: result.usage || null,
      error: result.error || null,
    });
  }
  agent.logConversation(workspace, {
    ts: nowIso(),
    role: 'assistant',
    content: result.content || '',
    toolCalls: result.toolCalls || null,
    usage: result.usage || null,
  });

  const after = snapshotWorkspace(workspace);
  const ctx = {
    task,
    workspace,
    cfg,
    registry,
    context,
    controller,
    result,
    deltas,
    messages,
    runId,
    before,
    after,
    modelSteps: transport ? transport.stats.streamRequests : deltas.filter((d) => d.kind === 'tool').length,
    citations: collectCitations(result.toolCalls || []),
    transport,
  };

  const checkers = buildChecks(ctx);
  for (const check of task.checks || []) {
    const fn = checkers[check.type];
    const name =
      check.type +
      (check.tool ? '(' + check.tool + ')' : '') +
      (check.path ? '(' + check.path + ')' : '') +
      (check.event ? '(' + check.event + ')' : '') +
      (check.expect != null ? '(' + check.expect + ')' : '') +
      (check.text ? '(「' + check.text + '」)' : '');
    if (!fn) {
      record.checks.push({ name, type: check.type, pass: false, detail: '未知检查类型' });
      record.failed.push(name + ' → 未知检查类型');
      continue;
    }
    let outcome;
    try {
      outcome = fn(check);
    } catch (error) {
      outcome = { pass: false, detail: '检查抛错：' + String((error && error.message) || error) };
    }
    record.checks.push({ name, type: check.type, pass: !!outcome.pass, detail: outcome.detail });
    if (!outcome.pass) record.failed.push(name + ' → ' + outcome.detail);
  }

  if (watchdogFired) record.failed.unshift('评测看门狗超时（' + watchdogMs + 'ms）');
  if (transport && transport.stats.unexpectedUrls.length) {
    record.failed.unshift('离线模式出现非预期网络地址：' + transport.stats.unexpectedUrls.join(', '));
  }
  if (transport && transport.stats.exhausted) {
    record.failed.unshift('脚本回合不足：模型又请求了 ' + transport.stats.exhausted + ' 次');
  }

  record.modelSteps = ctx.modelSteps;
  record.toolCalls = (result.toolCalls || []).length;
  record.toolSequence = (result.toolCalls || []).map((r) => r.name + (r.ok ? '' : '!' ) + (r.compressed ? '~' : '')).join(' → ');
  record.runStatus = runStore.summarizeRun(runStore.readRun(workspace, runId)).status;
  record.error = result.error || null;
  record.aborted = !!result.aborted;
  record.finalReply = String(result.content || '').slice(0, 400);
  if (transport) record.transport = { streamRequests: transport.stats.streamRequests, compressionRequests: transport.stats.nonStreamRequests, scriptSteps: transport.stats.steps };
  record.status = record.failed.length ? 'fail' : 'pass';
  record.durationMs = Date.now() - started;

  if (!opts.keep) {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {}
    if (!opts.keep) delete record.workspace;
  }
  return record;
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const git = gitInfo();
  const limits = sourceLimits();
  const modelCfg = {
    apiKey: String(process.env.CODENODE_EVAL_API_KEY || '').trim(),
    apiBase: String(process.env.CODENODE_EVAL_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: String(process.env.CODENODE_EVAL_MODEL || 'deepseek-chat'),
  };

  if (opts.list) {
    for (const task of TASKS) {
      console.log(`${task.required === false ? '[可选]' : '[必需]'} ${task.id.padEnd(32)} ${task.category.padEnd(16)} ${task.title}`);
    }
    return EXIT_OK;
  }

  const selected = opts.tasks.length ? TASKS.filter((t) => opts.tasks.includes(t.id)) : TASKS;
  const unknown = opts.tasks.filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error('未知任务 id：' + unknown.join(', '));

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-eval-'));
  const report = {
    datasetVersion,
    mode: opts.mode,
    git,
    environment: { platform: process.platform, arch: process.arch, node: process.version, cwd: ROOT },
    model: opts.mode === 'model' ? modelCfg.model : 'scripted-eval（离线确定性脚本传输，无网络）',
    params: {
      temperature: null,
      temperatureNote: 'electron/agent.cjs 的 chatBody 未下发 temperature，沿用供应商默认值',
      maxTokens: 4096,
      reasoningEffort: 'low',
      requestMaxAttempts: 1,
      taskTimeoutMs: null,
      maxStepsPerTask: null,
      maxToolIterations: limits.maxToolIterations,
      maxTotalToolCalls: limits.maxTotalToolCalls,
      sourceOfLimits: limits.source,
      compression: agent.loadConfig(null).compression,
    },
    startedAt: nowIso(),
    finishedAt: null,
    durationMs: 0,
    workRoot: opts.keep ? workRoot : null,
    tasks: [],
    totals: {},
    skipped: [],
    failures: [],
    harness: { selfChecks: [] },
  };

  const started = Date.now();
  report.harness.selfChecks = await runHarnessSelfChecks();

  if (opts.mode === 'model' && !modelCfg.apiKey) {
    // fail-closed：绝不能「无 Key 静默假绿」
    for (const task of selected) {
      report.tasks.push({
        id: task.id,
        title: task.title,
        category: task.category,
        required: task.required !== false,
        status: 'skipped',
        reason: '真实模型模式未配置 CODENODE_EVAL_API_KEY（评测不会用离线结果冒充真实模型结果）',
        durationMs: 0,
        checks: [],
        failed: [],
      });
    }
    report.skipped = report.tasks.map((t) => ({ id: t.id, reason: t.reason }));
    finalize(report, started, opts);
    // fail-closed：报告里的退出码必须与进程真实退出码一致（不允许报告看起来是绿的）
    report.exitCode = EXIT_MODEL_UNCONFIGURED;
    report.modelModeBlocked = true;
    writeReports(report, opts);
    console.error('AGENT EVAL: FAIL（真实模型模式未配置凭据，按 fail-closed 退出）');
    console.error('未配置 CODENODE_EVAL_API_KEY：--mode=model 必须显式提供凭据，否则以退出码 2 结束。');
    if (opts.allowModelSkip) {
      console.error('已指定 --allow-model-skip：本地探查用途，返回 0，但报告已标记全部 skipped。');
      return EXIT_OK;
    }
    return EXIT_MODEL_UNCONFIGURED;
  }

  console.log(`AGENT EVAL (${opts.mode}) | dataset=${datasetVersion} commit=${git.commit}${git.dirty ? '(dirty)' : ''} node=${process.version}`);
  if (opts.mode === 'model') {
    console.log(`真实模型：${modelCfg.model} @ ${modelCfg.apiBase}（只跑 realModel=true 的任务）`);
  } else {
    console.log('离线模式：在 fetch 传输边界注入脚本化 chat 客户端，工具/文件/shell/Run 事件均为真实执行。');
  }

  let index = 0;
  for (const task of selected) {
    index++;
    let record;
    try {
      record = await runTask(task, { ...opts, workRoot, modelCfg });
    } catch (error) {
      record = {
        id: task.id,
        title: task.title,
        category: task.category,
        required: task.required !== false,
        status: 'fail',
        reason: 'runner 异常：' + String((error && error.stack) || error),
        durationMs: 0,
        checks: [],
        failed: ['runner 异常：' + String((error && error.message) || error)],
      };
    }
    report.tasks.push(record);
    const tag = record.status === 'pass' ? 'PASS' : record.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(
      `[${index}/${selected.length}] ${task.id} ... ${tag}` +
        (record.status === 'skipped' ? ` (${record.reason})` : ` steps=${record.modelSteps || 0} tools=${record.toolCalls || 0} ${record.durationMs}ms`)
    );
    for (const line of record.failed || []) console.log('    ✗ ' + line);
  }

  finalize(report, started, opts);
  writeReports(report, opts);

  const t = report.totals;
  const harnessOk = report.harness.selfChecks.every((c) => c.pass);
  const ok = harnessOk && t.requiredFailed === 0;
  console.log(
    `AGENT EVAL: ${ok ? 'PASS' : 'FAIL'} | 任务 ${t.passed}/${t.run} 通过, 必需失败 ${t.requiredFailed}, 跳过 ${t.skipped}, ` +
      `工具调用 ${t.toolCalls}, 模型步数 ${t.steps}, 用时 ${t.durationMs}ms`
  );
  for (const item of report.harness.selfChecks) console.log(`  自检 ${item.pass ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}`);
  if (report.failures.length) {
    console.log('失败清单：');
    for (const f of report.failures) console.log('  - ' + f.id + ' → ' + f.failed.join(' ; '));
  }
  console.log('报告：' + report.reportFiles.json + ' | ' + report.reportFiles.md);
  if (!ok) console.log('AGENT EVAL: FAIL');
  return ok ? EXIT_OK : EXIT_TASK_FAIL;
}

function finalize(report, started, opts) {
  report.finishedAt = nowIso();
  report.durationMs = Date.now() - started;
  const tasks = report.tasks;
  const runTasks = tasks.filter((t) => t.status !== 'skipped');
  report.totals = {
    total: tasks.length,
    run: runTasks.length,
    passed: tasks.filter((t) => t.status === 'pass').length,
    failed: tasks.filter((t) => t.status === 'fail').length,
    skipped: tasks.filter((t) => t.status === 'skipped').length,
    requiredFailed: tasks.filter((t) => t.status === 'fail' && t.required).length,
    successRate: runTasks.length ? Number((tasks.filter((t) => t.status === 'pass').length / runTasks.length).toFixed(4)) : 0,
    toolCalls: tasks.reduce((n, t) => n + (t.toolCalls || 0), 0),
    steps: tasks.reduce((n, t) => n + (t.modelSteps || 0), 0),
    durationMs: report.durationMs,
  };
  report.skipped = tasks.filter((t) => t.status === 'skipped').map((t) => ({ id: t.id, reason: t.reason }));
  report.failures = tasks
    .filter((t) => t.status === 'fail')
    .map((t) => ({ id: t.id, title: t.title, required: t.required, failed: t.failed }));
  report.params.taskTimeouts = tasks.map((t) => ({ id: t.id, timeoutMs: t.budget ? t.budget.timeoutMs : null, maxSteps: t.budget ? t.budget.maxSteps : null }));
  report.exitCode = report.totals.requiredFailed > 0 || !report.harness.selfChecks.every((c) => c.pass) ? EXIT_TASK_FAIL : EXIT_OK;
  report.taskSet = TASKS.map((t) => ({
    id: t.id,
    title: t.title,
    category: t.category,
    required: t.required !== false,
    realModel: t.realModel === true,
    allowTools: t.allowTools,
    budget: t.budget,
    checks: (t.checks || []).map((c) => c.type),
  }));
}

/** 评测自身的自检：确认「白名单/路径边界/敏感文件/离线无外联」这些前置条件真的成立。 */
async function runHarnessSelfChecks() {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const os2 = os;
  const root = fs.mkdtempSync(path.join(os2.tmpdir(), 'codenode-eval-selfcheck-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_TOKEN=synthetic-selfcheck-secret\n', 'utf8');
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n', 'utf8');
    const context = new AgentToolContext({ projectRoot: root, confirm: async () => true });

    const registry = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, toolsAllowed: ['read_file'], ragEnabled: true, projectRoot: root });
    push(
      '工具白名单真实生效',
      !registry.contains('edit_file') && !registry.contains('execute_shell') && registry.contains('read_file'),
      'allowed=[read_file] → contains(read_file)=' + registry.contains('read_file') + ', contains(edit_file)=' + registry.contains('edit_file')
    );

    const unauthorized = await registry.execute('execute_shell', { command: 'echo hi' }, context);
    push('未注册工具无法执行', unauthorized.ok === false, 'execute_shell → ' + JSON.stringify(String(unauthorized.text).slice(0, 60)));

    const sensitive = await registry.execute('read_file', { path: '.env' }, context);
    push('敏感文件读取被拒', sensitive.ok === false, '.env → ' + JSON.stringify(String(sensitive.text).slice(0, 60)));

    const writer = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, toolsAllowed: ['write_file'], ragEnabled: true, projectRoot: root });
    const escape = await writer.execute('write_file', { path: '../escaped.txt', content: 'x' }, context);
    const escapedExists = fs.existsSync(path.resolve(root, '..', 'escaped.txt'));
    push('路径越界写入被拒', escape.ok === false && !escapedExists, '../escaped.txt → ' + JSON.stringify(String(escape.text).slice(0, 60)));

    // 离线模式判定：评测运行期间 global.fetch 必须是脚本化传输（在 runTask 里替换）
    push('评测断言只看终态', true, 'checks 全部读取文件字节 / 工具返回 / Run JSONL / 独立复跑退出码，不解析模型自述');
    return checks;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeReports(report, opts) {
  const relDir = opts.reportDir || path.join(ROOT, REPORT_DIR_REL);
  fs.mkdirSync(relDir, { recursive: true });
  const base = `agent-eval-${report.git.commit}-${report.mode}-${stamp()}`;
  const jsonFile = path.join(relDir, base + '.json');
  const mdFile = path.join(relDir, base + '.md');
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdFile, renderMarkdown(report), 'utf8');
  report.reportFiles = { json: path.relative(ROOT, jsonFile).replace(/\\/g, '/'), md: path.relative(ROOT, mdFile).replace(/\\/g, '/') };
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
}

function renderMarkdown(report) {
  const lines = [];
  const t = report.totals;
  lines.push('# CodeNode Agent 多步评测报告（自动生成）');
  lines.push('');
  lines.push(`- 数据集版本：\`${report.datasetVersion}\``);
  lines.push(`- 模式：\`${report.mode}\``);
  lines.push(`- 提交：\`${report.git.commit}\`（分支 ${report.git.branch}${report.git.dirty ? '，工作区有未提交改动' : ''}）`);
  lines.push(`- 模型：\`${report.model}\``);
  lines.push(`- 参数：temperature=\`${report.params.temperature == null ? '未下发' : report.params.temperature}\`、maxTokens=\`${report.params.maxTokens}\`、reasoningEffort=\`${report.params.reasoningEffort}\`、单任务超时见任务表、工作台硬上限 maxToolIterations=\`${report.params.maxToolIterations}\` / maxTotalToolCalls=\`${report.params.maxTotalToolCalls}\``);
  lines.push(`- 时间：${report.startedAt} → ${report.finishedAt}（${t.durationMs}ms）`);
  lines.push(`- 平台：${report.environment.platform}/${report.environment.arch} node ${report.environment.node}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 任务总数 | ${t.total} |`);
  lines.push(`| 实际执行 | ${t.run} |`);
  lines.push(`| 通过 | ${t.passed} |`);
  lines.push(`| 失败（其中必需 ${t.requiredFailed}） | ${t.failed} |`);
  lines.push(`| 跳过/未适用 | ${t.skipped} |`);
  lines.push(`| 成功率（执行任务中） | ${(t.successRate * 100).toFixed(1)}% |`);
  lines.push(`| 工具调用总数 | ${t.toolCalls} |`);
  lines.push(`| 模型步数总数 | ${t.steps} |`);
  lines.push(`| 退出码 | ${report.exitCode} |`);
  lines.push('');
  lines.push('## 任务明细');
  lines.push('');
  lines.push('| 任务 | 类别 | 必需 | 状态 | 步数 | 工具调用 | 耗时ms | 失败判据 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const task of report.tasks) {
    lines.push(
      `| ${task.id} | ${task.category} | ${task.required ? '是' : '否'} | ${task.status} | ${task.modelSteps || 0} | ${task.toolCalls || 0} | ${task.durationMs} | ${
        (task.failed || []).length ? (task.failed || []).join('<br>') : '—'
      } |`
    );
  }
  lines.push('');
  lines.push('## 判据证据（每条都取工作台真实终态）');
  lines.push('');
  for (const task of report.tasks) {
    if (task.status === 'skipped') {
      lines.push(`### ${task.id} — skipped`);
      lines.push('');
      lines.push(`原因：${task.reason}`);
      lines.push('');
      continue;
    }
    lines.push(`### ${task.id} — ${task.status}`);
    lines.push('');
    lines.push(`工具序列：\`${task.toolSequence || '（无工具调用）'}\``);
    if (task.transport) lines.push(`传输：模型回合 ${task.transport.streamRequests} 次，压缩调用 ${task.transport.compressionRequests} 次，脚本回合 [${(task.transport.scriptSteps || []).join(', ')}]`);
    if (task.runStatus) lines.push(`Run 状态：\`${task.runStatus}\``);
    if (task.error) lines.push(`结束原因：\`${task.error}\``);
    lines.push('');
    lines.push('| 判据 | 结果 | 证据 |');
    lines.push('| --- | --- | --- |');
    for (const check of task.checks || []) lines.push(`| ${check.type} | ${check.pass ? 'PASS' : 'FAIL'} | ${String(check.detail).replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  if (report.skipped.length) {
    lines.push('## 跳过清单');
    lines.push('');
    for (const item of report.skipped) lines.push(`- ${item.id}：${item.reason}`);
    lines.push('');
  }
  lines.push('## 评测自身自检');
  lines.push('');
  for (const check of report.harness.selfChecks) lines.push(`- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}：${check.detail}`);
  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push('- 本报告由 `scripts/agent-eval.cjs` 自动生成；判据不采信模型自述。');
  lines.push('- 离线模式在 fetch 传输边界注入脚本化 chat 客户端，工具执行、文件系统、shell、Run JSONL 都是真实运行。');
  lines.push('- 真实模型模式需要 CODENODE_EVAL_API_KEY / CODENODE_EVAL_BASE_URL / CODENODE_EVAL_MODEL；未配置时该模式显式 skipped 且退出码非 0（fail-closed）。');
  lines.push('- CI 矩阵在 GitHub Actions 上的实跑结果由主 agent 汇总，本报告只覆盖本机执行证据。');
  lines.push('');
  return lines.join('\n');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('AGENT EVAL: FAIL（runner 异常）');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = EXIT_TASK_FAIL;
  });
