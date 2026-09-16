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
    // S8 补齐：回放摘要（一眼看清这次运行发生了什么）
    const summaryText = spawnSync(process.execPath, [cli, projectRoot, '--run', RUN_ID, '--summary'], { encoding: 'utf8' });
    check('C4 CLI --summary 打印回放摘要（工具调用/事件类型）',
      summaryText.status === 0 && /工具调用/.test(summaryText.stdout) && /事件类型/.test(summaryText.stdout),
      summaryText.stdout.slice(0, 200));
    const summaryJson = spawnSync(process.execPath, [cli, projectRoot, '--run', RUN_ID, '--json', '--summary'], { encoding: 'utf8' });
    let parsedSummary = null;
    try {
      parsedSummary = JSON.parse(summaryJson.stdout);
    } catch {}
    check('C5 --json --summary 同时给出结构化摘要',
      !!parsedSummary && !!parsedSummary.summary && parsedSummary.summary.toolCalls > 0,
      JSON.stringify(parsedSummary && parsedSummary.summary && { toolCalls: parsedSummary.summary.toolCalls }));
  }

  // ======================= D. 其余日志也进统一流（S8 补齐） =======================
  {
    const projectRoot = path.join(root, 'bridge');
    fs.mkdirSync(projectRoot, { recursive: true });
    const bridgeRun = 'run-bridge';

    require('../electron/runStore.cjs').startRun(projectRoot, bridgeRun, { goal: 'bridge-test' });
    require('../electron/runCheckpoint.cjs').recordIntent(projectRoot, bridgeRun, { callId: 'call-cp', tool: 'write_file', argsDigest: 'digest-cp', effect: 'write', idemKey: 'idem-cp' });
    const { SideEffectLedger } = require('../electron/sideEffects.cjs');
    const ledger = new SideEffectLedger({ projectRoot, scopeRunId: bridgeRun });
    const guard = await ledger.begin('write_file', { path: 'a.txt' });
    if (guard && guard.token) await ledger.commit(guard.token, { ok: true, result: 'written' });
    const { CostLedger } = require('../electron/costLedger.cjs');
    new CostLedger({ projectRoot, runId: bridgeRun }).record({ kind: 'chat', model: 'bridge-model', usage: { total: 12, cached: 5 }, costUsd: 0.002 });
    const approvalCtx = new AgentToolContext({ projectRoot, confirm: async () => true, runId: bridgeRun });
    await approvalCtx.approval().request({ capability: 'workspace.write', what: 'write_file', detail: '桥接用例', scope: ['workspace.write:a.txt'], toolCallId: 'call-apv' });
    eventBus.bridge(projectRoot, 'audit', { entry: '审计桥接用例（ipc 层的 auditLog 走的就是这条桥）' });

    const bridgeEvents = eventBus.readEvents(projectRoot);
    const bridgeKinds = new Set(bridgeEvents.map((e) => e.kind));
    for (const kind of ['run_state', 'checkpoint', 'side_effect', 'cost', 'approval', 'audit']) {
      check('D ' + kind + ' 已进入统一事件流', bridgeKinds.has(kind), JSON.stringify([...bridgeKinds]));
    }
    const costEvent = bridgeEvents.find((e) => e.kind === 'cost');
    check('D7 成本事件带 runId 与 token 用量（回放能看到花了多少）',
      !!costEvent && costEvent.runId === bridgeRun && !!costEvent.tokens,
      JSON.stringify(costEvent && { runId: costEvent.runId, tokens: costEvent.tokens }));
    const approvalEvent = bridgeEvents.find((e) => e.kind === 'approval');
    check('D8 审批事件带 toolCallId（能对上具体调用）',
      !!approvalEvent && approvalEvent.toolCallId === 'call-apv',
      JSON.stringify(approvalEvent && { event: approvalEvent.event, toolCallId: approvalEvent.toolCallId }));
  }

  // ======================= E. 回放摘要（纯函数） =======================
  {
    const s = eventBus.summarize([
      { kind: 'tool', name: 'read_file', ok: true },
      { kind: 'tool', name: 'read_file', ok: false },
      { kind: 'failure_taxonomy', nudged: [{ code: 'ARG_SCHEMA', tool: 'read_file' }] },
      { kind: 'approval', event: 'approval_issued' },
      { kind: 'approval', event: 'approval_consumed' },
      { kind: 'cost', costUsd: 0.003, tokens: { total: 100 } },
    ]);
    check('E1 摘要统计工具调用与失败', s.toolCalls === 2 && s.toolFailures === 1 && s.tools.read_file.calls === 2, JSON.stringify(s.tools));
    check('E2 摘要统计失败码与审批', s.failureCodes.ARG_SCHEMA === 1 && s.approvals.issued === 1 && s.approvals.consumed === 1, JSON.stringify(s.approvals));
    check('E3 摘要统计成本与 token', s.costUsd === 0.003 && s.tokens === 100, JSON.stringify({ costUsd: s.costUsd, tokens: s.tokens }));
    check('E4 空事件的摘要不编造数据', eventBus.summarize([]).total === 0 && eventBus.summarize([]).costUsd === 0);
  }

  // ======================= F. UI / IPC 载荷（replayPayload） =======================
  {
    const payloadRoot = path.join(root, 'payload');
    fs.mkdirSync(payloadRoot, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      eventBus.emit(payloadRoot, { kind: 'tool', runId: 'run-payload', turnId: '0', toolCallId: 'call_' + i, name: 'read_file', ok: i !== 5 });
    }
    const full = eventBus.replayPayload(payloadRoot, {});
    check('F1 载荷结构完整（ok / file / total / runs / events / summary）',
      full.ok === true && typeof full.file === 'string' && full.total === 5 && Array.isArray(full.runs) && full.events.length === 5 && !!full.summary,
      JSON.stringify({ ok: full.ok, total: full.total, events: full.events.length }));
    const limited = eventBus.replayPayload(payloadRoot, { limit: 2 });
    check('F2 limit 只截断时间线，摘要仍按全量统计（界面看「最近」，摘要看「全部」）',
      limited.events.length === 2 && limited.summary.total === 5 && limited.summary.toolFailures === 1,
      JSON.stringify({ events: limited.events.length, summaryTotal: limited.summary.total, failures: limited.summary.toolFailures }));
    const byRun = eventBus.replayPayload(payloadRoot, { runId: 'run-payload' });
    const other = eventBus.replayPayload(payloadRoot, { runId: 'no-such-run' });
    check('F3 runId 过滤生效（不存在的 run 返回空载荷且不抛）',
      byRun.total === 5 && other.ok === true && other.total === 0 && other.events.length === 0 && other.summary.total === 0,
      JSON.stringify({ byRun: byRun.total, other: other.total }));
    const empty = eventBus.replayPayload(path.join(root, 'nothing-here'), {});
    check('F4 没有事件文件时不抛异常、返回空载荷', empty.ok === true && empty.total === 0 && empty.summary.total === 0);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('EVENT REPLAY TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('EVENT REPLAY TEST: ERROR', e);
  process.exit(1);
});
