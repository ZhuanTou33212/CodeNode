/**
 * agent-iterations-test.cjs —— 「模型步数」必须是真发出去的请求次数（2026-09-17）
 *
 * 缺口（真实模型评测暴露）：评测的 `steps-at-most` 判据取自 `runAgentChat` 的返回值，
 * 而 model 模式下 agent-eval 数的是 **`kind:'tool'` 的 delta 条数** —— 那是**流式分片数**
 * （真实 DeepSeek 把一次工具调用的参数切得极碎，实测 3 次工具调用 = 77 条 delta），
 * 于是 `模型步数 ≤ 6` 在真实供应商下**恒红**：4 个必过任务全部只因这一条判据失败，
 * 而它们的终态判据（改动落地 / 独立复跑）都通过了 —— 门禁红的是判据，不是产品。
 *
 * 修法：主循环自己数**成功的模型请求次数**（`modelTurns`），通过返回值 `iterations`
 * 如实上报（8 个返回点全带上），turn_end 事件同时带 `modelTurns`；评测侧改用它，
 * 取不到（非有限数）时**显式判失败**，绝不当 0（当 0 会让上限判据永远绿）。
 *
 * 判据全部落在运行时可见的事实上：返回值 vs. stub 真实请求次数 vs. 落盘的 round_end 条数。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-iterations-'));

/** 真实注册表 + 真实工具循环，只有模型返回是脚本 */
async function runLoop(options) {
  const projectRoot = options.projectRoot;
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'hello\n', 'utf8');
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot, userDataDir: projectRoot });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot, ragEnabled: false });
  const controller = new AbortController();
  if (options.preAborted) controller.abort();
  const context = new AgentToolContext({
    projectRoot,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: controller.signal,
  });
  const cfg = {
    apiBase: 'http://127.0.0.1:9',
    apiKey: 'scripted-key',
    model: 'scripted',
    maxTokens: 512,
    costRunId: options.runId,
    tools: {},
    limits: options.limits || {},
    compression: { enabled: false },
    reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
  };
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  // unreachableApi：不装脚本模型，让真实 fetch 打 127.0.0.1:9（连接被拒）→ 走失败返回路径
  const stub = options.unreachableApi
    ? { calls: 0, restore: () => {} }
    : installScriptedModel(options.script, { loopLast: options.loopLast !== false });
  let out;
  try {
    out = await agent.runAgentChat({ cfg, messages, tools: { registry, context }, onDelta: () => {}, signal: controller.signal });
  } finally {
    stub.restore();
  }
  /** 落盘 trace 里的 round_end 条数与 turn_end.modelTurns（与返回值互为对证的第二个来源） */
  let roundEnds = 0;
  let turnEndModelTurns = null;
  let turnEndIterations = null;
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.codenode', 'tools_trace.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.kind === 'round_end') roundEnds++;
      if (entry.kind === 'turn_end') {
        turnEndModelTurns = entry.modelTurns;
        turnEndIterations = entry.iterations;
      }
    }
  } catch {}
  return { out, modelCalls: stub.calls, roundEnds, turnEndModelTurns, turnEndIterations };
}

(async () => {
  // ============ A. 一轮工具 + 收尾回答：返回值 == 真实请求次数 == 落盘 round_end ============
  {
    const r = await runLoop({
      projectRoot: path.join(root, 'normal'),
      runId: 'run-normal',
      script: [
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
        { content: '完成' },
      ],
    });
    check('A1 两轮请求 → iterations=2', r.out.iterations === 2, String(r.out.iterations));
    check('A2 与真实模型请求次数一致（stub.calls）', r.out.iterations === r.modelCalls, `iterations=${r.out.iterations} stub=${r.modelCalls}`);
    // round_end 是「带工具的一轮」而不是「模型一轮」：收尾那轮没有工具、直接 break —— 两个数不可混用
    check('A3 round_end 只统计带工具轮（2 轮请求 → 1 条 round_end），与步数是两个量',
      r.roundEnds === 1 && r.out.iterations === 2, `round_end=${r.roundEnds} iterations=${r.out.iterations}`);
    check('A4 turn_end 事件同时报 modelTurns 与 loopIterations', r.turnEndModelTurns === 2 && r.turnEndIterations === 2,
      JSON.stringify({ modelTurns: r.turnEndModelTurns, loopIterations: r.turnEndIterations }));
    check('A5 工具真的执行了（不是空转）', (r.out.toolCalls || []).length === 1, String((r.out.toolCalls || []).length));
  }

  // ============ B. 进入循环前就被取消：0 次请求就不能报 1（旧口径的 off-by-one） ============
  {
    const r = await runLoop({
      projectRoot: path.join(root, 'aborted'),
      runId: 'run-aborted',
      preAborted: true,
      script: [{ content: '不该被调用' }],
    });
    check('B1 提前取消 → iterations=0（一个请求都没发出去）', r.out.iterations === 0, String(r.out.iterations));
    check('B2 提前取消 → 真实请求次数也是 0', r.modelCalls === 0, String(r.modelCalls));
    check('B3 提前取消 → aborted=true 且没有 round_end', r.out.aborted === true && r.roundEnds === 0,
      JSON.stringify({ aborted: r.out.aborted, roundEnds: r.roundEnds }));
  }

  // ============ C. 请求没成功：不该计步，且字段必须是有限数（评测侧据此 fail-closed） ============
  {
    const r = await runLoop({
      projectRoot: path.join(root, 'failed'),
      runId: 'run-failed',
      unreachableApi: true,
    });
    check('C1 请求失败 → iterations=0 且为有限数', r.out.iterations === 0 && Number.isFinite(r.out.iterations), String(r.out.iterations));
    check('C2 失败信息如实上报（不是静默成功）', !!r.out.error, String(r.out.error).slice(0, 100));
  }

  // ============ D. 撞上限：步数 = 上限，且与 trace 对得上 ============
  {
    const r = await runLoop({
      projectRoot: path.join(root, 'limit'),
      runId: 'run-limit',
      limits: { maxToolIterations: 2 },
      script: [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }],
    });
    check('D1 上限 2 → iterations=2', r.out.iterations === 2, String(r.out.iterations));
    check('D2 与真实请求次数一致', r.out.iterations === r.modelCalls, `iterations=${r.out.iterations} stub=${r.modelCalls}`);
    check('D3 终态是 LIMIT_REACHED 且 stopReason=iteration_limit', r.out.state === 'LIMIT_REACHED' && r.out.stopReason === 'iteration_limit',
      JSON.stringify({ state: r.out.state, stopReason: r.out.stopReason }));
  }

  // ============ E. 截断补问也要计步（同一轮里的追加请求是真实的模型调用） ============
  {
    const r = await runLoop({
      projectRoot: path.join(root, 'truncate'),
      runId: 'run-truncate',
      loopLast: false,
      script: [
        { content: '半截回答', finishReason: 'length' },
        { content: '完整回答' },
      ],
    });
    check('E1 截断补问 → 2 次请求都被计入', r.out.iterations === 2 && r.out.iterations === r.modelCalls,
      `iterations=${r.out.iterations} stub=${r.modelCalls}`);
  }

  // ============ F. 评测侧口径：不再数 SSE 分片（判据来源正确） ============
  {
    const src = fs.readFileSync(path.resolve(__dirname, 'agent-eval.cjs'), 'utf8');
    check('F1 评测的 modelSteps 取自 result.iterations', /modelSteps:\s*transport\s*\?\s*transport\.stats\.streamRequests\s*:\s*Number\(result&&/i.test(src.replace(/\s+/g, ' ')) || /Number\(result && result\.iterations\)/.test(src),
      '源码命中');
    check('F2 评测不再用 kind === \'tool\' 的分片数当步数', !/modelSteps:[^\n]*d\.kind === 'tool'/.test(src));
    check('F3 取不到步数时 fail-closed（显式判失败）', /Number\.isFinite\(ctx\.modelSteps\)/.test(src));
  }

  console.log(failures ? 'AGENT ITERATIONS TEST: FAIL (' + failures + ')' : 'AGENT ITERATIONS TEST: PASS');
  process.exitCode = failures ? 1 : 0;
})().catch((error) => {
  console.error('测试异常：', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
