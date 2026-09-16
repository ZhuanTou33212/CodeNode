/**
 * event-replay-test.cjs —— 统一事件流 + 按 run 回放（S8）
 *
 * 回归缺口（审查 §3 P2「事件模型不统一」）：一次运行的事件散在 runs/*.jsonl、
 * tools_trace.jsonl、checkpoints.jsonl、side-effects.json、audit.jsonl 五套文件里；
 * tools_trace 的每条只有 `{ts, iter, name …}`，**没有 runId / turnId / toolCallId** ——
 * 「按 run 回放这一轮到底发生了什么」做不到。
 *
 * 判据：
 *   A. 纯函数层：形状归一（标识字段字符串化、缺 kind 丢弃）、坏行不影响其余事件、
 *      replay 能按 run / kinds 过滤；
 *   B. 真实工具循环：跑一次 read_file，`.codenode/events.jsonl` 里的 tool 事件必须带
 *      runId / turnId / toolCallId / attemptId，且 toolCallId 与 assistant 声明的 id 一致；
 *   C. CLI：`scripts/event-replay.cjs` 能按 run 过滤并给出 0/1 退出码。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const eventBus = require('../electron/eventBus.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-events-'));
const RUN_ID = 'run-events-1';

function makeCfg() {
  return {
    apiBase: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    model: 'scripted',
    maxTokens: 512,
    reasoningEffort: 'low',
    costRunId: RUN_ID,
    tools: {},
    limits: {},
    compression: { enabled: false },
    reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
  };
}

(async () => {
  // ======================= A. 纯函数 =======================
  {
    const dir = path.join(root, 'pure');
    fs.mkdirSync(dir, { recursive: true });
    const emitted = eventBus.emit(dir, { kind: 'tool', runId: 7, turnId: 0, toolCallId: 'c1', name: 'read_file', ok: true });
    check('A1 emit 归一化：runId 数字被字符串化', emitted && emitted.runId === '7' && emitted.turnId === '0', JSON.stringify(emitted));
    check('A2 缺 kind 的事件被丢弃（返回 null 且不写盘）', eventBus.emit(dir, { runId: 'x' }) === null);
    check('A3 没有 projectRoot 时不写盘（返回 null）', eventBus.emit(null, { kind: 'tool' }) === null);

    // 坏行 / 无 kind 行不能影响其余事件（断电半写的真实形态）
    fs.appendFileSync(eventBus.eventsPath(dir), '{半截 JSON\n' + JSON.stringify({ ts: 'x', runId: 'y' }) + '\n', 'utf8');
    eventBus.emit(dir, { kind: 'round_end', runId: '7', turnId: 0, toolCount: 1 });
    const events = eventBus.readEvents(dir);
    check('A4 坏行与非事件行被跳过，其余事件完整读回', events.length === 2 && events[1].kind === 'round_end', JSON.stringify(events.map((e) => e.kind)));

    const other = path.join(root, 'pure2');
    eventBus.emit(other, { kind: 'tool', runId: 'other', turnId: 1, name: 'write_file' });
    const report = eventBus.replay(other, { runId: 'other' });
    check('A5 replay 按 run 过滤', report.total === 1 && report.runs.length === 1 && report.runs[0].runId === 'other', JSON.stringify({ total: report.total }));
    check('A6 replay 按 kinds 过滤到 0 条时也如实返回', eventBus.replay(other, { kinds: ['nope'] }).total === 0);
    check('A7 formatEvent 输出含 kind 与标识', /tool/.test(eventBus.formatEvent(events[0])) && /c1/.test(eventBus.formatEvent(events[0])), eventBus.formatEvent(events[0]));
  }

  // ======================= B. 真实工具循环 =======================
  {
    const projectRoot = path.join(root, 'live');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'line1\nline2\n', 'utf8');
    const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot, userDataDir: projectRoot });
    sandbox.setDefaultPolicy(policy);
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot, ragEnabled: false, toolsAllowed: ['read_file'] });
    const context = new AgentToolContext({
      projectRoot,
      confirm: async () => true,
      audit: () => {},
      sandbox: policy,
      signal: new AbortController().signal,
    });
    const stub = installScriptedModel(
      [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: '读完了。' }],
      { loopLast: false },
    );
    let out;
    try {
      out = await agent.runAgentChat({
        cfg: makeCfg(),
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '读 a.txt' }],
        tools: { registry, context },
        onDelta: () => {},
      });
    } finally {
      stub.restore();
    }
    check('B1 循环正常结束且有工具调用', out.toolCalls.length === 1 && out.toolCalls[0].name === 'read_file', JSON.stringify(out.toolCalls.map((t) => t.name)));

    const events = eventBus.readEvents(projectRoot);
    const toolEvents = events.filter((e) => e.kind === 'tool');
    const declaredId = out.toolCalls[0].callId;
    check('B2 events.jsonl 里 tool 事件带 runId/turnId/toolCallId/attemptId',
      toolEvents.length === 1 && toolEvents[0].runId === RUN_ID && toolEvents[0].turnId === '0' &&
        toolEvents[0].toolCallId === declaredId && toolEvents[0].attemptId === declaredId + '#1',
      JSON.stringify(toolEvents.map((e) => ({ runId: e.runId, turnId: e.turnId, call: e.toolCallId, attempt: e.attemptId }))));
    check('B3 每一条事件都是统一形状（v/ts/kind 齐备）',
      events.length > 0 && events.every((e) => e.v === 1 && typeof e.ts === 'string' && typeof e.kind === 'string'),
      JSON.stringify(events.map((e) => e.kind)));
    check('B4 round_end / turn_end 也都归属同一个 run',
      events.some((e) => e.kind === 'round_end' && e.runId === RUN_ID) && events.some((e) => e.kind === 'turn_end' && e.runId === RUN_ID),
      JSON.stringify(events.map((e) => e.kind + ':' + e.runId)));
    check('B5 旧 tools_trace.jsonl 仍在写（兼容一个版本周期）',
      fs.existsSync(path.join(projectRoot, '.codenode', 'tools_trace.jsonl')),
      path.join(projectRoot, '.codenode', 'tools_trace.jsonl'));
    const replayed = eventBus.replay(projectRoot, { runId: RUN_ID });
    check('B6 replay 能按 run 取回整条时间线（含工具事件）',
      replayed.total === events.length && replayed.runs[0].events.some((e) => e.kind === 'tool'),
      JSON.stringify({ total: replayed.total, all: events.length }));
  }

  // ======================= C. CLI =======================
  {
    const projectRoot = path.join(root, 'live');
    const cli = path.join(__dirname, 'event-replay.cjs');
    const hit = spawnSync(process.execPath, [cli, projectRoot, '--run', RUN_ID, '--json'], { encoding: 'utf8' });
    let parsed = null;
    try {
      parsed = JSON.parse(hit.stdout);
    } catch {}
    check('C1 CLI 按 run 回放成功（退出码 0 + JSON 可解析）',
      hit.status === 0 && parsed && parsed.total > 0 && parsed.runs[0].runId === RUN_ID,
      JSON.stringify({ status: hit.status, total: parsed && parsed.total }));
    const miss = spawnSync(process.execPath, [cli, projectRoot, '--run', 'no-such-run'], { encoding: 'utf8' });
    check('C2 没有匹配事件时退出码为 1（可直接用于门禁）', miss.status === 1, String(miss.status));
    const kinds = spawnSync(process.execPath, [cli, projectRoot, '--kinds', 'tool'], { encoding: 'utf8' });
    check('C3 --kinds 过滤生效且文本输出含工具名', kinds.status === 0 && /read_file/.test(kinds.stdout), kinds.stdout.slice(0, 200));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('EVENT REPLAY TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('EVENT REPLAY TEST: ERROR', e);
  process.exit(1);
});
