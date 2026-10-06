/**
 * run-rollback-test.cjs —— Run 级文件回滚（§4.2 的第三件事）
 *
 * 判据分四段（全部落在**磁盘字节**与**只读计划**上，不采信返回值自述）：
 *   A. 前像抓取：写操作第一次执行前抓一次；内容寻址落 blob；同路径第二次写不覆盖前像；
 *      过大/不可读 → `restorable:false` 如实标注。
 *   B. planRollback 必须**只读**（跑一次工作区字节不变）、只读 Run 无可回滚项、缺前像如实 skip。
 *   C. applyRollback：还原逐字节一致 / 新建文件被删 / 冲突默认拒绝（force 才动）/
 *      越界路径拒绝且根外文件不受影响 / blob 损坏拒绝且目标不被改 / 事件留痕 / 有 refused 时 ok=false。
 *   D. 端到端：走**真实工具链**（registry.execute + createGuard）写盘，再回滚 —— 证明生产路径真的抓了前像。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SideEffectLedger, createGuard, beforeImageDir, BEFORE_IMAGE_CAP, digest } = require('../electron/sideEffects.cjs');
const { planRollback, applyRollback } = require('../electron/runRollback.cjs');
const runStore = require('../electron/runStore.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');
const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-rollback-' + tag + '-'));
}
/** 工作区字节快照（用于「plan 只读」与「没被改」的负向判据） */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (rel.startsWith('.codenode')) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else out[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

// ============================ A. 前像抓取 ============================
console.log('== A. 前像抓取（第一次写之前、内容寻址、超大如实标注） ==');
const rootA = tmpdir('a');
fs.writeFileSync(path.join(rootA, 'a.txt'), 'ORIGINAL');
const ledgerA = new SideEffectLedger({ projectRoot: rootA, scopeRunId: 'run-a' });
// 顺序必须与生产一致：begin（抓前像）→ 工具写盘 → commit（记写后状态）
const t1 = ledgerA.begin('write_file', { path: 'a.txt', content: 'V2' });
const img1 = ledgerA.beforeImages.get('a.txt');
check('[A] 改写已有文件 → 前像 existed:true + restorable:true', img1 && img1.existed === true && img1.restorable === true, JSON.stringify(img1));
const blobA = path.join(beforeImageDir(rootA, 'run-a'), String(img1 && img1.blob));
check('[A] blob 落盘且内容 == 改前正文', fs.existsSync(blobA) && fs.readFileSync(blobA, 'utf8') === 'ORIGINAL', blobA);
fs.writeFileSync(path.join(rootA, 'a.txt'), 'V2');
ledgerA.commit(t1, { ok: true });

const t2 = ledgerA.begin('write_file', { path: 'new.txt', content: 'X' });
const img2 = ledgerA.beforeImages.get('new.txt');
check('[A] 写不存在的新文件 → 前像 existed:false（回滚 = 删掉）', img2 && img2.existed === false && img2.restorable === true, JSON.stringify(img2));
fs.writeFileSync(path.join(rootA, 'new.txt'), 'X');
ledgerA.commit(t2, { ok: true });

const t3 = ledgerA.begin('write_file', { path: 'a.txt', content: 'V3' });
const img3 = ledgerA.beforeImages.get('a.txt');
check('[A] 同一路径第二次写 → 前像**仍是 Run 开始前那份**（不覆盖）', img3 && img1 && img3.sha256 === img1.sha256, JSON.stringify({ first: img1 && img1.sha256, second: img3 && img3.sha256 }));
check('[A] 前像按内容寻址：只有「存在过的文件」才落 blob（本例仅 a.txt 一份）', fs.readdirSync(beforeImageDir(rootA, 'run-a')).length === 1, fs.readdirSync(beforeImageDir(rootA, 'run-a')).join(','));
fs.writeFileSync(path.join(rootA, 'a.txt'), 'V3');
ledgerA.commit(t3, { ok: true });

fs.writeFileSync(path.join(rootA, 'big.txt'), 'x'.repeat(BEFORE_IMAGE_CAP + 10));
const t4 = ledgerA.begin('write_file', { path: 'big.txt', content: 'small' });
const img4 = ledgerA.beforeImages.get('big.txt');
check('[A] 超大文件 → restorable:false + reason=too-large（不假装能回滚）', img4 && img4.restorable === false && img4.reason === 'too-large', JSON.stringify(img4));
ledgerA.commit(t4, { ok: true });

const t5 = ledgerA.begin('read_file', { path: 'a.txt' });
check('[A] 只读工具不抓前像（不浪费 I/O）', !ledgerA.beforeImages.has('a-only-read') && !t5.skip && ledgerA.beforeImages.size === 3, JSON.stringify([...ledgerA.beforeImages.keys()]));

// ============================ B. plan 只读 ============================
console.log('\n== B. planRollback 只读 + 分类 ==');
const beforeSnapshot = JSON.stringify(snapshot(rootA));
const planA = planRollback(rootA, 'run-a');
check('[B] plan 成功且分类正确（a.txt restore / new.txt delete / big.txt skip）', planA.ok
  && planA.items.find((i) => i.path === 'a.txt').action === 'restore'
  && planA.items.find((i) => i.path === 'new.txt').action === 'delete'
  && planA.items.find((i) => i.path === 'big.txt').action === 'skip', JSON.stringify(planA.summary) + ' ' + planA.items.map((i) => i.path + ':' + i.action).join(','));
check('[B] plan 是只读的：工作区字节快照完全不变', JSON.stringify(snapshot(rootA)) === beforeSnapshot);
check('[B] 只读 Run 没有任何可回滚项（负向）', (() => {
  const rootB = tmpdir('b');
  fs.writeFileSync(path.join(rootB, 'x.txt'), 'x');
  const l = new SideEffectLedger({ projectRoot: rootB, scopeRunId: 'run-readonly' });
  l.begin('read_file', { path: 'x.txt' });
  const p = planRollback(rootB, 'run-readonly');
  return p.ok && p.items.length === 0 && p.summary.restore === 0 && p.summary.delete === 0;
})());
check('[B] 缺前像（旧账本）→ skip + reason=no-before-image（不猜）', (() => {
  const rootB = tmpdir('b2');
  fs.mkdirSync(path.join(rootB, '.codenode', 'runs'), { recursive: true });
  const file = path.join(rootB, '.codenode', 'runs', 'legacy.side-effects.json');
  fs.writeFileSync(file, JSON.stringify({ records: [{ idemKey: 'k', tool: 'write_file', effect: 'write', phase: 'committed', statePath: 'y.txt' }] }));
  const p = planRollback(rootB, 'legacy');
  return p.ok && p.items.length === 1 && p.items[0].action === 'skip' && p.items[0].reason === 'no-before-image';
})());

// ============================ C. apply ============================
console.log('\n== C. applyRollback（还原 / 删除 / 冲突 / 越界 / blob 损坏 / 留痕） ==');
runStore.startRun(rootA, 'run-a', { prompt: '回滚用例', model: 'test' });
const applyA = applyRollback(rootA, 'run-a');
check('[C] 还原 a.txt 到 Run 开始前内容（逐字节）', fs.readFileSync(path.join(rootA, 'a.txt'), 'utf8') === 'ORIGINAL', JSON.stringify(fs.readFileSync(path.join(rootA, 'a.txt'), 'utf8')));
check('[C] 删除本次 Run 新建的 new.txt', !fs.existsSync(path.join(rootA, 'new.txt')));
check('[C] 超大项 skip 且 ok=false（如实报告「这个撤不了」）', applyA.skipped.some((s) => s.path === 'big.txt') && applyA.ok === false, JSON.stringify({ summary: applyA.summary, skipped: applyA.skipped }));
check('[C] 回滚事件落进 Run 事件流（rollback_applied）', runStore.readRun(rootA, 'run-a').some((event) => event.type === 'rollback_applied'), runStore.readRun(rootA, 'run-a').map((e) => e.type).join(','));

// 冲突：写完之后别人又改过该文件 → 默认拒绝，force 才动
const rootC = tmpdir('c');
fs.writeFileSync(path.join(rootC, 'c.txt'), 'BASE');
const ledgerC = new SideEffectLedger({ projectRoot: rootC, scopeRunId: 'run-c' });
const tc = ledgerC.begin('write_file', { path: 'c.txt', content: 'AGENT' });
ledgerC.commit(tc, { ok: true });
fs.writeFileSync(path.join(rootC, 'c.txt'), 'AGENT');
fs.writeFileSync(path.join(rootC, 'c.txt'), 'SOMEONE-ELSE'); // 模拟本 Run 之后被别人改过
const planC = planRollback(rootC, 'run-c');
check('[C] 本 Run 之后被外部改过 → 计划标记 conflict', planC.items[0].conflict === true, JSON.stringify(planC.items[0]));
const noForce = applyRollback(rootC, 'run-c');
check('[C] 默认拒绝改冲突项（不覆盖别人的改动）', noForce.applied.length === 0 && noForce.refused.some((r) => r.reason === 'conflict-needs-force') && fs.readFileSync(path.join(rootC, 'c.txt'), 'utf8') === 'SOMEONE-ELSE');
const forced = applyRollback(rootC, 'run-c', { force: true });
check('[C] force:true 才执行，且还原到 Run 前内容', forced.applied.length === 1 && fs.readFileSync(path.join(rootC, 'c.txt'), 'utf8') === 'BASE', JSON.stringify(forced.summary));

// 越界路径：账本里的 path 试图逃出项目根 → 拒绝且根外文件不受影响
const rootD = tmpdir('d');
const outside = path.join(path.dirname(rootD), 'rollback-outside.txt');
fs.rmSync(outside, { force: true });
fs.mkdirSync(path.join(rootD, '.codenode', 'runs'), { recursive: true });
const escImgDir = beforeImageDir(rootD, 'run-esc');
fs.mkdirSync(escImgDir, { recursive: true });
const escContent = 'EVIL-BEFORE';
const escSha = digest(escContent); // 必须用账本自己的 digest 口径（32 字符），否则会被判成 blob 损坏
fs.writeFileSync(path.join(escImgDir, escSha + '.txt'), escContent);
fs.writeFileSync(path.join(rootD, '.codenode', 'runs', 'run-esc.side-effects.json'), JSON.stringify({
  records: [{ idemKey: 'k', tool: 'write_file', effect: 'write', phase: 'committed', statePath: '../rollback-outside.txt' }],
  beforeImages: { '../rollback-outside.txt': { path: '../rollback-outside.txt', existed: true, restorable: true, sha256: escSha, blob: escSha + '.txt' } },
}));
const esc = applyRollback(rootD, 'run-esc');
check('[C] 越界路径被拒（path-out-of-root），根外文件未被创建/改动', esc.refused.some((r) => String(r.reason).startsWith('path-out-of-root')) && !fs.existsSync(outside), JSON.stringify({ refused: esc.refused, outsideExists: fs.existsSync(outside) }));

// blob 损坏：前像本体被改 → 拒绝写盘（fail-closed）
const rootE = tmpdir('e');
fs.writeFileSync(path.join(rootE, 'e.txt'), 'ORIG');
const ledgerE = new SideEffectLedger({ projectRoot: rootE, scopeRunId: 'run-e' });
const te = ledgerE.begin('write_file', { path: 'e.txt', content: 'NEW' });
const blobE = path.join(beforeImageDir(rootE, 'run-e'), String(ledgerE.beforeImages.get('e.txt').blob));
fs.writeFileSync(path.join(rootE, 'e.txt'), 'NEW');
ledgerE.commit(te, { ok: true });
fs.writeFileSync(blobE, 'TAMPERED');
const broken = applyRollback(rootE, 'run-e');
check('[C] blob 哈希对不上 → 拒绝写盘且目标保持现状', broken.refused.some((r) => r.reason === 'before-image-blob-corrupt') && fs.readFileSync(path.join(rootE, 'e.txt'), 'utf8') === 'NEW', JSON.stringify(broken.refused));

// ============================ D. 端到端（真实工具链） ============================
console.log('\n== D. 端到端：真实工具循环（主循环 beginSideEffect/commitSideEffect）写盘后回滚 ==');
const rootF = tmpdir('f');
fs.writeFileSync(path.join(rootF, 'target.txt'), 'PROD-ORIGINAL');
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: rootF, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);
const ledgerF = new SideEffectLedger({ projectRoot: rootF, scopeRunId: 'run-f' });
runStore.startRun(rootF, 'run-f', { prompt: '端到端回滚', model: 'scripted' });
const contextF = new AgentToolContext({
  projectRoot: rootF,
  confirm: async () => true,
  audit: () => {},
  ragConfig: { enabled: false },
  sandbox: policy,
  signal: new AbortController().signal,
  sideEffectGuard: createGuard(ledgerF),
});
// 关键：**账本记录由主循环写入**（agent.cjs 在每次工具调用前后调 beginSideEffect/commitSideEffect），
// 所以这里必须跑真实循环 —— 直接 registry.execute 绕过了那一层，账本会是空的（第一版就这么误判过）。
const stubF = installScriptedModel(
  [
    {
      toolCalls: [
        { name: 'write_file', args: { path: 'target.txt', content: 'PROD-NEW' } },
        { name: 'write_file', args: { path: 'brand-new.txt', content: 'NEW-FILE' } },
      ],
    },
    { content: '完成' },
  ],
  { loopLast: false }
);
agent
  .runAgentChat({
    cfg: {
      apiBase: 'http://scripted.local/v1',
      apiKey: '',
      model: 'scripted-f',
      maxTokens: 1024,
      reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
      limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
      compression: { enabled: false },
      rag: { enabled: false },
      tools: {},
    },
    messages: [
      { role: 'system', content: '测试用 system' },
      { role: 'user', content: '写两个文件' },
    ],
    tools: {
      registry: toolkit.buildDefaultRegistryWithConfig({ projectRoot: rootF, ragEnabled: false, toolsAllowed: ['write_file'] }),
      context: contextF,
    },
    signal: new AbortController().signal,
    timeoutMs: 20000,
  })
  .then((result) => {
    stubF.restore();
    check('[D] 真实工具循环写完（盘上确实是新内容）', fs.readFileSync(path.join(rootF, 'target.txt'), 'utf8') === 'PROD-NEW' && fs.existsSync(path.join(rootF, 'brand-new.txt')), JSON.stringify({ content: String(result.content || '').slice(0, 40), toolCalls: (result.toolCalls || []).length }));
    const plan = planRollback(rootF, 'run-f');
    check('[D] 生产路径真的抓到了前像（不是只有直调账本才抓）', plan.items.length === 2 && plan.items.every((i) => i.restorable), JSON.stringify(plan.items.map((i) => i.path + ':' + i.action)));
    const done = applyRollback(rootF, 'run-f');
    check('[D] 回滚成功：target.txt 逐字节还原 + 新建文件被删', done.ok === true && fs.readFileSync(path.join(rootF, 'target.txt'), 'utf8') === 'PROD-ORIGINAL' && !fs.existsSync(path.join(rootF, 'brand-new.txt')), JSON.stringify(done.summary));

    for (const dir of [rootA, rootC, rootD, rootE, rootF]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
    console.log('\n' + (failures === 0 ? 'RUN ROLLBACK TEST: PASS（前像 / 计划 / 执行 / 端到端）' : 'RUN ROLLBACK TEST: FAIL —— ' + failures + ' 项断言未通过'));
    process.exit(failures ? 1 : 0);
  })
  .catch((error) => {
    console.error('RUN ROLLBACK TEST: FAIL —— ' + String((error && error.stack) || error));
    process.exit(1);
  });
