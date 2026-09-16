/**
 * agent-limits-test.cjs —— 循环硬上限从源码常量变成可配置（P5）
 *
 * 缺口（审查 §3 P2「预算维度只有 token 与硬编码轮数/调用数」）：
 *   MAX_TOOL_ITERATIONS = 12 / MAX_TOTAL_TOOL_CALLS = 100 / DATA_TRUNCATE_CAP = 120000
 *   是 agent.cjs 里的源码常量，项目/用户无法按场景调整（也没有任何配置键能覆盖）。
 *
 * 修法：agent.max_tool_iterations / agent.max_total_tool_calls / agent.data_truncate_cap
 * 三个配置键，默认值与旧常量逐字一致（不配就完全等价）。
 *
 * 判据：默认值不变（防止配置化顺手改了行为）；配小了之后**真实循环**确实按新上限停下，
 * 且 stopReason / 文案如实说明是「上限」而不是「失败」。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-limits-'));

/** 用真实注册表 + 真实工具循环跑一次脚本化对话 */
async function runLoop(options) {
  const projectRoot = options.projectRoot;
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot, userDataDir: projectRoot });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot,
    ragEnabled: false,
    toolsAllowed: ['read_file'],
  });
  const context = new AgentToolContext({
    projectRoot,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
  const cfg = {
    apiBase: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    model: 'scripted',
    maxTokens: 512,
    costRunId: options.runId,
    tools: {},
    limits: options.limits || {},
    compression: { enabled: false },
    reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
  };
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  const stub = installScriptedModel(options.script, { loopLast: true });
  let out;
  try {
    out = await agent.runAgentChat({ cfg, messages, tools: { registry, context }, onDelta: () => {} });
  } finally {
    stub.restore();
  }
  return { out, messages, modelCalls: stub.calls };
}

(async () => {
  // ======================= A. 默认值与旧常量逐字一致 =======================
  {
    const d = agent.parseLimitsConfig({});
    check('A1 默认 maxToolIterations=12', d.maxToolIterations === 12, JSON.stringify(d));
    check('A2 默认 maxTotalToolCalls=100', d.maxTotalToolCalls === 100, JSON.stringify(d));
    check('A3 默认 dataTruncateCap=120000', d.dataTruncateCap === 120000, JSON.stringify(d));
    const c = agent.parseLimitsConfig({
      'agent.max_tool_iterations': '4',
      'agent.max_total_tool_calls': '7',
      'agent.data_truncate_cap': '5000',
    });
    check('A4 配置键可覆盖', c.maxToolIterations === 4 && c.maxTotalToolCalls === 7 && c.dataTruncateCap === 5000, JSON.stringify(c));
    const clamped = agent.parseLimitsConfig({ 'agent.max_tool_iterations': '0' });
    check('A5 越界值被钳制到区间内（0 → 1，不会变成「不限制」）', clamped.maxToolIterations === 1, String(clamped.maxToolIterations));
  }

  // ======================= B. 迭代上限真实生效 =======================
  {
    const projectRoot = path.join(root, 'iter');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'hello\n', 'utf8');
    // 模型每一轮都发工具调用（永远不算完），上限配成 2 轮
    const { out, modelCalls } = await runLoop({
      projectRoot,
      runId: 'run-iter',
      limits: { maxToolIterations: 2 },
      script: [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }],
    });
    check('B1 上限为 2 时只向模型请求 2 次', modelCalls === 2, String(modelCalls));
    check('B2 stopReason=iteration_limit（不是 FAILED）', out.stopReason === 'iteration_limit', JSON.stringify({ stopReason: out.stopReason, error: out.error }));
    check('B3 文案说明是「迭代上限」而不是执行失败', /迭代上限/.test(String(out.error || '')), String(out.error));
    check('B4 状态机终态为 LIMIT_REACHED', out.state === 'LIMIT_REACHED', String(out.state));
  }

  // ======================= C. 单次运行的工具调用总数上限 =======================
  {
    const projectRoot = path.join(root, 'calls');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'hello\n', 'utf8');
    const { out } = await runLoop({
      projectRoot,
      runId: 'run-calls',
      limits: { maxTotalToolCalls: 1 },
      script: [
        {
          toolCalls: [
            { name: 'read_file', args: { path: 'a.txt' } },
            { name: 'read_file', args: { path: 'a.txt' } },
          ],
        },
      ],
    });
    check('C1 上限为 1 时只执行 1 个工具调用', out.toolCalls.length === 1, String(out.toolCalls.length));
    check('C2 stopReason=tool_limit（不是 FAILED）', out.stopReason === 'tool_limit', JSON.stringify({ stopReason: out.stopReason }));
    check('C3 文案说明是「工具调用上限」', /工具调用上限/.test(String(out.error || '')), String(out.error));
  }

  // ======================= D. 结果截断上限 =======================
  {
    const projectRoot = path.join(root, 'truncate');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'big.txt'), 'x'.repeat(8000) + '\n', 'utf8');
    const { messages } = await runLoop({
      projectRoot,
      runId: 'run-truncate',
      limits: { dataTruncateCap: 1000 },
      script: [{ toolCalls: [{ name: 'read_file', args: { path: 'big.txt' } }] }, { content: 'ok' }],
    });
    const toolMsg = messages.find((m) => m.role === 'tool');
    const len = toolMsg ? String(toolMsg.content || '').length : -1;
    check('D1 data_truncate_cap=1000 时回灌内容被截断（8000 字文件不会原样进上下文）', len > 0 && len < 4000, String(len));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('AGENT LIMITS TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('AGENT LIMITS TEST: ERROR', e);
  process.exit(1);
});
