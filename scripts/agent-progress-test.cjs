/**
 * agent-progress-test.cjs —— 进度检查层（每 N 轮注入一条「只讲事实」的任务清单）
 *
 * 修的是 harness 审计短板表里那条 P3：「无规划/进度检查层」（Java 版每 3 步注入任务清单，
 * Electron 版没有）。实测症状是长任务后几轮在同一件事上打转、或忘了最初目标。
 *
 * 设计要点（判据锁这些）：
 *   1. 只讲**可核对的事实**：轮次 / 已用工具调用数 / 已改动文件 / 失败次数与最近错误码 / 用量；
 *      不给评价、不编进度 —— 并要求下一步先交代「目标 / 已完成 / 下一步」。
 *   2. 注入点在**压缩与硬裁剪之后**、请求之前：放在前面的话本次迭代的压缩会把这条机器注入的
 *      user 消息一并丢掉，模型本轮根本看不到（等于白注）。
 *   3. 前缀是 `【系统提示】`（compaction 的 MACHINE_USER_PREFIXES 里已有）→ 机器注入、不进摘要。
 *   4. 同一时刻**只保留一条**：旧的那条原地替换（不 splice —— 缓存条目里存着消息下标，
 *      挪动下标会让后端缓存回填改错消息）。
 *
 * 负向判据：`agent.progress_every=0`（或未配置）→ 一个请求里都不许出现进度清单。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const compaction = require('../electron/compaction.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-progress-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'v1\n');

const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

let lastSeen = [];
async function runTurn(script, cfgOverrides = {}) {
  // limits 单独合并：progressEvery 就住在 limits 里（接线口径与 loadConfig 一致）；
  // 先从 overrides 里摘掉，避免同一个对象字面量里出现两个 limits 键（tsc 会报 TS1117）
  const { limits: limitsOverride, ...restOverrides } = cfgOverrides || {};
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    askUser: async () => '',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const stub = installScriptedModel(script, { loopLast: false });
  try {
    const result = await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: 'k',
        model: 'scripted-model',
        maxTokens: 1024,
        reasoningEffort: '',
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
        ...restOverrides,
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1, ...(limitsOverride || {}) },
      },
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '请完成测试任务' },
      ],
      tools: {
        registry: toolkit.buildDefaultRegistryWithConfig({
          projectRoot: root,
          ragEnabled: false,
          toolsAllowed: ['read_file', 'write_file', 'list_directory'],
        }),
        context,
      },
      signal: controller.signal,
      timeoutMs: 20000,
    });
    lastSeen = stub.seen || [];
    return result;
  } finally {
    stub.restore();
  }
}

/** 从一次请求的 messages 里摘出进度清单（最多几条） */
function notesIn(request) {
  const list = (request && request.messages) || [];
  return list.filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(agent.PROGRESS_NOTE_PREFIX));
}

/** 两轮工具调用 + 收尾（共 3 次模型请求） */
const FOUR_TURN_SCRIPT = [
  { toolCalls: [{ id: 'p1', name: 'write_file', args: { path: 'work/a.txt', content: 'v2\n' } }] },
  { toolCalls: [{ id: 'p2', name: 'read_file', args: { path: 'work/a.txt' } }] },
  { toolCalls: [{ id: 'p3', name: 'definitely_missing_tool', args: {} }] },
  { toolCalls: [{ id: 'p4', name: 'list_directory', args: { path: 'work' } }] },
  { content: '完成' },
];

(async () => {
  // ---------------- 纯函数：内容只讲事实，且是机器注入 ----------------
  const note = agent.buildProgressNote({
    iteration: 3,
    maxIterations: 12,
    toolCallsUsed: 7,
    toolCallBudget: 100,
    changedFiles: ['work/a.txt', 'work/b.md'],
    failures: [{ tool: 'write_file', code: 'RESOURCE_LOCKED' }],
    tokensUsed: 12345,
    tokenBudget: 600000,
  });
  check('[D] 清单带真实的轮次/调用数/预算', /第 3\/12 轮/.test(note) && /工具调用 7\/100 次/.test(note), note.slice(0, 90));
  check('[D] 清单列出已改动文件（含个数）', /已改动文件 2 个（work\/a\.txt、work\/b\.md）/.test(note));
  check('[D] 清单报失败次数与最近错误码', /失败 1 次（最近：write_file\/RESOURCE_LOCKED）/.test(note));
  check('[D] 清单报用量与预算', /用量 12345\/600000 tokens/.test(note));
  check('[D] 要求下一步交代目标/已完成/下一步（不是空话）', /当前目标/.test(note) && /已完成/.test(note) && /下一步要做的/.test(note));
  check('[D] 前缀即机器注入标记（compaction 不会把它带进摘要）', compaction.isMachineInjectedUserMessage(note) === true && agent.PROGRESS_NOTE_PREFIX.startsWith('【系统提示】'));
  const empty = agent.buildProgressNote({ iteration: 1, maxIterations: 12, toolCallsUsed: 0, toolCallBudget: 100 });
  check('[D] 零进展时也是事实（0 个文件、0 次失败），不编造', /已改动文件 0 个/.test(empty) && /失败 0 次/.test(empty) && !/tokens/.test(empty));

  // ---------------- 端到端：到了第 N 轮必须注入 ----------------
  console.log('== 端到端（progress_every=2）==');
  await runTurn(FOUR_TURN_SCRIPT, { limits: { progressEvery: 2 } });
  const req1 = lastSeen[0];
  const req3 = lastSeen[2];
  check('[D] 第 1 轮（iter=0）不注入', notesIn(req1).length === 0);
  check('[D] 第 3 轮（iter=2，到点）注入一条', notesIn(req3).length === 1, JSON.stringify(notesIn(req3).map((m) => m.content.slice(0, 60))));
  const injected = notesIn(req3)[0] ? notesIn(req3)[0].content : '';
  check('[D] 注入的是**真实进度**（此时已 2 次工具调用、改过 work/a.txt）', /工具调用 2\/100 次/.test(injected) && /work\/a\.txt/.test(injected), injected.slice(0, 140));
  check('[D] 注入的消息是 user 角色（模型会当成上下文提示读）', notesIn(req3)[0] && notesIn(req3)[0].role === 'user');

  // ---------------- 端到端：同一时刻只留一条（原地替换，不堆叠） ----------------
  console.log('== 端到端（progress_every=1，每轮都注入 → 必须只留一条）==');
  const everyTurn = await runTurn(
    [
      { toolCalls: [{ id: 'q1', name: 'read_file', args: { path: 'work/a.txt' } }] },
      { toolCalls: [{ id: 'q2', name: 'read_file', args: { path: 'work/a.txt' } }] },
      { toolCalls: [{ id: 'q3', name: 'list_directory', args: { path: 'work' } }] },
      { content: '完成' },
    ],
    { limits: { progressEvery: 1 } }
  );
  check('[D] 每轮都到点时，最后一次请求里仍然只有一条清单', notesIn(lastSeen[3]).length === 1, JSON.stringify(notesIn(lastSeen[3]).length));
  const finalNotes = ((lastSeen[3] && lastSeen[3].messages) || []).filter(
    (m) => m && typeof m.content === 'string' && m.content.startsWith(agent.PROGRESS_NOTE_PREFIX)
  );
  check('[D] 历史里也不会堆叠（旧的那条被原地替换）', finalNotes.length === 1);
  check('[D] 替换后仍是最新数字（越往后调用数只增不减）', /工具调用 3\/100 次/.test(finalNotes[0] ? finalNotes[0].content : ''), finalNotes[0] ? finalNotes[0].content.slice(0, 90) : '');
  check('[D] 每轮注入不影响正常收尾（回答仍交付）', String(everyTurn.content || '').includes('完成'));

  // ---------------- 负向：关掉就一个都不许出现 ----------------
  console.log('== 负向判据 ==');
  await runTurn(FOUR_TURN_SCRIPT, { limits: { progressEvery: 0 } });
  check('[D] progress_every=0 → 所有请求里都没有进度清单', lastSeen.every((req) => notesIn(req).length === 0), 'requests=' + lastSeen.length);
  await runTurn(FOUR_TURN_SCRIPT, {});
  check('[D] 未配置（手工 cfg）→ 同样不注入（不改变既有行为）', lastSeen.every((req) => notesIn(req).length === 0));
  await runTurn(FOUR_TURN_SCRIPT, { limits: { progressEvery: 5 } });
  check('[D] 阈值 5、只跑了 4 轮 → 不到点就不注入', lastSeen.every((req) => notesIn(req).length === 0), 'requests=' + lastSeen.length);

  // 出厂配置口径：parseConfig 默认 3（改了默认值要在这里红）
  check(
    '[D] 出厂默认 agent.progress_every=3，且落在 limits（接线正确 —— 放错段会让主循环读不到）',
    agent.loadConfig(root).limits.progressEvery === 3 && agent.loadConfig(root).reliability.progressEvery === undefined,
    JSON.stringify({ limits: agent.loadConfig(root).limits.progressEvery, reliability: agent.loadConfig(root).reliability.progressEvery })
  );

  console.log(failures === 0 ? 'AGENT PROGRESS TEST: PASS' : 'AGENT PROGRESS TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('AGENT PROGRESS TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
