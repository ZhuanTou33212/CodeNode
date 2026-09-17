/**
 * subagent-envelope-test.cjs —— 子代理结果的**单一 JSON 信封**契约（多 Agent 信息完整性 P1/P2）
 *
 * 判据都在「可观察终态」：信封字段值 / 违约项清单 / 工具结果 ok 与文本 / audit 记录，
 * 不看内部变量。核心是**负向**判据：缺字段、缺快照、无结论、无原因 → 必须被拒收，
 * 而不是把不可采信的东西当结论递给主代理（那正是「信任放大」）。
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const envelopeLib = require('../electron/subagentEnvelope.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('PASS  ' + label);
  } catch (error) {
    failures++;
    console.log('FAIL  ' + label + ' :: ' + (error && error.message ? error.message : error));
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-envelope-'));
sandbox.setDefaultPolicy(sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() }));

const baseTask = (over = {}) => ({
  taskId: 'task-1',
  runId: 'run-1',
  role: 'builder',
  objective: '写 a.txt',
  status: 'done',
  summary: '结论：写完了',
  toolCalls: [],
  totalTimeoutMs: 600000,
  ...over,
});
const canvasModel = () => new GraphModel({ root: { nodes: [{ id: 'n1', type: 'task', position: { x: 0, y: 0 }, data: {} }], edges: [] } });

(async () => {
  // ---- 1. 契约齐全：无违约、trust 不给 verified、文本是单一信封 ----
  check('[契约] 齐备 → 无违约，trust=derived（不自动升 verified）', () => {
    const built = envelopeLib.buildEnvelope({ task: baseTask(), projectRoot: root, model: canvasModel(), changedFiles: [] });
    assert.deepStrictEqual(built.violations, []);
    assert.strictEqual(built.envelope.trust, 'derived');
    assert.strictEqual(built.envelope.kind, 'result');
    assert.strictEqual(built.envelope.v, 1);
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(built.envelope.snapshot.hash), '必须带世界状态哈希');
  });

  check('[契约] 渲染文本只有**一个** JSON 信封（不是字段头 + 正文两套）', () => {
    const built = envelopeLib.buildEnvelope({ task: baseTask(), projectRoot: root, model: canvasModel() });
    const text = envelopeLib.renderEnvelopeText(built.envelope, built.violations);
    assert.strictEqual((text.match(/```json/g) || []).length, 1, '只应有一个 json 块');
    const json = text.slice(text.indexOf('```json') + 7, text.lastIndexOf('```'));
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.msgId, 'm_task-1');
    assert.strictEqual(parsed.payload.objective, '写 a.txt');
  });

  // ---- 2. 负向：缺快照 / 缺字段 / 无结论 / 无原因 → 全部拒收 ----
  check('[负向] 没有画布（无 model）→ 缺 snapshot.hash 违约 + trust 降为 untrusted', () => {
    const built = envelopeLib.buildEnvelope({ task: baseTask(), projectRoot: root, model: null });
    assert.ok(built.violations.some((v) => v.path === 'snapshot.hash'), JSON.stringify(built.violations));
    assert.strictEqual(built.envelope.trust, 'untrusted');
    assert.ok(built.envelope.lossy.contractViolations.length >= 1, '违约项要写进信封，接收方看得见');
    assert.ok(envelopeLib.renderEnvelopeText(built.envelope, built.violations).includes('不得作为结论证据'));
  });

  check('[负向] result 却没有结论文本 / error 却没有原因 → 各自违约', () => {
    const blank = envelopeLib.validateEnvelope({
      v: 1, msgId: 'm', from: { runId: 'r', taskId: 't', role: 'builder' }, to: { taskId: 'supervisor' },
      snapshot: { hash: 'sha256:' + 'a'.repeat(64) }, kind: 'result', payload: { summary: '   ' },
      trust: 'derived', lossy: { isLossy: false },
    });
    assert.ok(blank.some((v) => v.path === 'payload.summary'), JSON.stringify(blank));
    const noReason = envelopeLib.validateEnvelope({
      v: 1, msgId: 'm', from: { runId: 'r', taskId: 't', role: 'builder' }, to: { taskId: 'supervisor' },
      snapshot: { hash: 'sha256:' + 'a'.repeat(64) }, kind: 'error', payload: { summary: '', error: '' },
      trust: 'untrusted', lossy: { isLossy: false },
    });
    assert.ok(noReason.some((v) => v.path === 'payload.error'), JSON.stringify(noReason));
  });

  check('[负向] 版本非法 / trust 非法 / 快照哈希不是 sha256 → 违约', () => {
    const v = envelopeLib.validateEnvelope({
      v: 2, msgId: 'm', from: { runId: 'r', taskId: 't', role: 'b' }, to: { taskId: 's' },
      snapshot: { hash: 'md5:zzz' }, kind: 'result', payload: { summary: 'ok' }, trust: 'trusted', lossy: { isLossy: false },
    });
    const paths = v.map((x) => x.path).sort();
    assert.deepStrictEqual(paths, ['snapshot.hash', 'trust', 'v'], JSON.stringify(v));
  });

  // ---- 3. 有损自报（P2）：截断必须带 droppedChars + 完整原文取回方式 ----
  check('[有损] 截断 → isLossy/droppedChars/originalRef 都对；未截断则 isLossy=false', () => {
    const long = 'x'.repeat(3000);
    const cut = envelopeLib.buildEnvelope({
      task: baseTask({ summary: long }), projectRoot: root, model: canvasModel(),
      summary: long.slice(0, 500), clipped: { droppedChars: 2500 },
    });
    assert.strictEqual(cut.envelope.lossy.isLossy, true);
    assert.strictEqual(cut.envelope.lossy.droppedChars, 2500);
    assert.ok(String(cut.envelope.lossy.originalRef).includes('get_subagent_task(taskId=task-1)'));
    assert.ok(envelopeLib.renderEnvelopeText(cut.envelope, []).includes('已截断'));
    const intact = envelopeLib.buildEnvelope({ task: baseTask(), projectRoot: root, model: canvasModel() });
    assert.strictEqual(intact.envelope.lossy.isLossy, false);
    assert.strictEqual(intact.envelope.lossy.droppedChars, undefined, '没丢东西就别写丢了 0（省体积也不误导）');
  });

  // ---- 4. 产物哈希是真的（能核验），工程外文件不算产物 ----
  check('[产物] 真文件 → sha256 与独立复算一致；改内容 → 哈希变', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    const call = { name: 'write_file', ok: true, args: JSON.stringify({ path: 'a.txt' }) };
    const first = envelopeLib.collectEvidence({ toolCalls: [call], projectRoot: root });
    const expect = 'sha256:' + crypto.createHash('sha256').update('hello', 'utf8').digest('hex');
    assert.strictEqual(first.files[0].sha256, expect);
    assert.strictEqual(first.files[0].exists, true);
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello2');
    const second = envelopeLib.collectEvidence({ toolCalls: [call], projectRoot: root });
    assert.notStrictEqual(second.files[0].sha256, first.files[0].sha256, '内容变了哈希必须变');
  });

  check('[产物] 声称改了但文件不存在 / 工程外路径 → 如实记录，不当产物', () => {
    const missing = envelopeLib.collectEvidence({
      toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: 'nope/missing.txt' }) }],
      projectRoot: root,
    });
    assert.strictEqual(missing.files[0].exists, false);
    assert.strictEqual(missing.files[0].sha256, null);
    assert.ok(missing.warnings.join(' ').includes('不存在'), JSON.stringify(missing.warnings));
    const outside = envelopeLib.collectEvidence({
      toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: path.join(os.tmpdir(), 'outside.txt') }) }],
      projectRoot: root,
    });
    assert.deepStrictEqual(outside.files, [], '工程外文件不是本工程产物');
  });

  check('[产物] 命令证据（execute_shell）如实记录成败，且不算产物文件', () => {
    const ev = envelopeLib.collectEvidence({
      toolCalls: [
        { name: 'execute_shell', ok: true, args: JSON.stringify({ command: 'npm test' }) },
        { name: 'execute_shell', ok: false, args: JSON.stringify({ command: 'npm run build' }) },
      ],
      projectRoot: root,
    });
    assert.deepStrictEqual(ev.commands, [{ cmd: 'npm test', ok: true }, { cmd: 'npm run build', ok: false }]);
    assert.deepStrictEqual(ev.files, []);
  });

  // ---- 5. 快照哈希可比对：键序无关、内容敏感 ----
  check('[快照] 键序无关 → 同一哈希；内容变一个字符 → 哈希变', () => {
    const a = envelopeLib.hashDocument({ root: { nodes: [{ id: 'n', x: 1, y: 2 }], edges: [] } });
    const b = envelopeLib.hashDocument({ root: { edges: [], nodes: [{ y: 2, id: 'n', x: 1 }] } });
    assert.strictEqual(a, b, '键序不同必须同哈希（否则比对无意义）');
    const c = envelopeLib.hashDocument({ root: { nodes: [{ id: 'n', x: 1, y: 3 }], edges: [] } });
    assert.notStrictEqual(a, c, '内容不同必须不同哈希');
  });

  // ---- 6. 端到端：契约违约 → 工具结果是 error（拒收），并留 audit ----
  {
    const audit = [];
    const controller = new AbortController();
    // 故意不给 model（没有世界状态锚点）+ 子代理只回空白 → 两处违约
    const context = new AgentToolContext({
      projectRoot: root,
      confirm: async () => true,
      audit: (line) => audit.push(line),
      askUser: async () => '',
      ragConfig: { enabled: false },
      sandbox: sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() }),
      signal: controller.signal,
    });
    const registry = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({
      agent: { runAgentChat: async () => ({ content: '   ', toolCalls: [], usage: { total_tokens: 10 } }) },
      toolkit,
      cfg: { tools: { toolsEnabled: true, toolsAllowed: [], toolsDeny: [] }, rag: { enabled: false }, subagent: {} },
      registry,
      runId: 'run-envelope',
    });
    manager.register(registry);
    const rejected = await registry.execute('delegate_task', { role: 'builder', objective: '写文件' }, context);
    check('[端到端] 缺快照/无结论 → 工具结果 error 且文本写明拒收', () => {
      assert.strictEqual(rejected.ok, false, '违约结果必须是失败的工具结果（不得被当结论使用）');
      assert.ok(String(rejected.text).includes('拒收'), '文本要明确说被拒收');
      assert.ok(String(rejected.text).includes('snapshot.hash'), '要列出违约项');
    });
    check('[端到端] 拒收留痕：audit 写 subagent_envelope_rejected', () => {
      assert.ok(audit.join('\n').includes('subagent_envelope_rejected'), 'audit 里必须能查到拒收');
    });
    check('[端到端] 拒收的结果不带 verified/derived 这种可采信等级', () => {
      assert.strictEqual(rejected.data.envelope.trust, 'untrusted');
    });
  }

  console.log(failures === 0 ? 'SUBAGENT ENVELOPE TEST: PASS' : 'SUBAGENT ENVELOPE TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SUBAGENT ENVELOPE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
