/**
 * side-effect-idempotency-test.cjs —— 副作用幂等账本（幂等键口径）
 *
 * 回归 bug（P0）：幂等键此前用 `JSON.stringify(args)` 原样序列化，键序敏感。
 * 缓存键（agent.cjs 的 canonicalArgs）是「排序后序列化」，两处口径不一致 →
 * 同一个写操作以不同键序重发时，缓存判定为重复、幂等账本却判定为新操作，
 * 中断续跑时**不会跳过已提交的写**，重复产生副作用（重复写文件 / 重复画布变更）。
 *
 * 本用例同时锁住两个方向：
 *   (a) 语义相同、键序不同（含嵌套）的参数必须得到同一个幂等键并被去重；
 *   (b) 只读工具与「未知副作用」工具**永远不能被自动跳过**（宁可人工复核，也不盲目重放）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SideEffectLedger, canonicalArgsText, classify, idempotencyKey } = require('../electron/sideEffects.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-idem-'));
const scope = 'run-scope-1';

function newLedger() {
  return new SideEffectLedger({ projectRoot: root, scopeRunId: scope });
}

(async () => {
  // ---- (0) 键序 / 嵌套 / 类型等价 ----
  const a = canonicalArgsText({ path: 'a.txt', content: 'X', mode: 'replace' });
  const b = canonicalArgsText({ mode: 'replace', content: 'X', path: 'a.txt' });
  check('canonicalArgsText：顶层键序无关', a === b, a + ' vs ' + b);
  const nested1 = canonicalArgsText({ ops: [{ nodeId: 'n1', value: 'v' }, { value: 'w', nodeId: 'n2' }], meta: { b: 1, a: 2 } });
  const nested2 = canonicalArgsText({ meta: { a: 2, b: 1 }, ops: [{ value: 'v', nodeId: 'n1' }, { nodeId: 'n2', value: 'w' }] });
  check('canonicalArgsText：嵌套对象/数组元素同样规范化', nested1 === nested2, nested1 + ' vs ' + nested2);
  check('canonicalArgsText：字符串形态的 JSON 参数按解析后规范化',
    canonicalArgsText('{"b":1,"a":2}') === canonicalArgsText({ a: 2, b: 1 }), canonicalArgsText('{"b":1,"a":2}'));
  check('canonicalArgsText：非 JSON 字符串原样返回（trim）', canonicalArgsText('  not-json  ') === 'not-json', canonicalArgsText('  not-json  '));
  check('idempotencyKey：键序不同的同一写操作得到同一个键',
    idempotencyKey(scope, 'write_file', { path: 'a.txt', content: 'X' }) === idempotencyKey(scope, 'write_file', { content: 'X', path: 'a.txt' }));
  check('idempotencyKey：不同工具/不同作用域不会撞键',
    idempotencyKey(scope, 'write_file', { path: 'a.txt' }) !== idempotencyKey(scope, 'edit_file', { path: 'a.txt' }) &&
    idempotencyKey(scope, 'write_file', { path: 'a.txt' }) !== idempotencyKey('run-scope-2', 'write_file', { path: 'a.txt' }));

  // ---- (1) 写操作：登记 → 提交 → 同参重启后必须跳过（键序不同也要跳过） ----
  const ledger1 = newLedger();
  const first = ledger1.begin('write_file', { path: 'a.txt', content: 'X' });
  check('写操作首次 begin 不跳过', first.skip === false && first.effect === 'write', JSON.stringify(first).slice(0, 120));
  ledger1.commit(first, { ok: true, result: 'written' });

  const again = ledger1.begin('write_file', { content: 'X', path: 'a.txt' }); // 键序不同
  check('同一进程内：键序不同的同参 write 被识别为已提交（skip）', again.skip === true, JSON.stringify(again).slice(0, 160));
  check('skip 时带上原因与原记录', !!again.prior && /已提交/.test(String(again.reason || '')), String(again.reason || ''));

  // 跨实例（模拟续跑：新进程重新打开同一账本）仍然跳过
  const ledger2 = newLedger();
  const resumed = ledger2.begin('write_file', { path: 'a.txt', content: 'X' });
  check('续跑（新 Ledger 实例读同一文件）：已提交的写操作仍被跳过', resumed.skip === true, JSON.stringify(resumed).slice(0, 160));

  // 参数真的变了 → 不能跳过（否则会漏掉一次必要的写入）
  const changed = ledger2.begin('write_file', { path: 'a.txt', content: 'Y' });
  check('参数不同（内容变化）的写操作不被跳过', changed.skip === false);
  ledger2.fail(changed, new Error('磁盘只读'));

  // ---- (2) 只读工具与未知副作用工具：永不自动跳过 ----
  const readFirst = ledger2.begin('read_file', { path: 'a.txt' });
  ledger2.commit(readFirst, { ok: true });
  const readAgain = ledger2.begin('read_file', { path: 'a.txt' });
  check('只读工具即使已提交也不跳过（重放是安全的）', readAgain.skip === false && readAgain.effect === 'read', JSON.stringify(readAgain).slice(0, 120));

  const shellFirst = ledger2.begin('execute_shell', { command: 'git status' });
  ledger2.commit(shellFirst, { ok: true });
  const shellAgain = ledger2.begin('execute_shell', { command: 'git status' });
  check('外部副作用（shell）已提交也不跳过：必须人工核对，禁止盲目重放', shellAgain.skip === false && shellAgain.effect === 'unknown', JSON.stringify(shellAgain).slice(0, 120));

  // 未登记的新工具按最保守的 unknown 处理（fail-closed），且不参与自动跳过
  const novel = ledger2.begin('brand_new_mutating_tool', { any: 1 });
  ledger2.commit(novel, { ok: true });
  check('未登记工具默认 unknown（fail-closed）且不跳过',
    classify('brand_new_mutating_tool') === 'unknown' && ledger2.begin('brand_new_mutating_tool', { any: 1 }).skip === false);

  // ---- (3) review 视图：unknown 与 pending 必须能与 committed 区分（续跑审查用） ----
  const view = ledger2.review();
  check('review：committed / pending / unknown 三分类齐全',
    Array.isArray(view.committed) && Array.isArray(view.pending) && Array.isArray(view.unknown) &&
      view.committed.length >= 1 && view.pending.length >= 1 && view.unknown.length >= 1,
    JSON.stringify({ committed: view.committed.length, pending: view.pending.length, unknown: view.unknown.length }));
  check('review：已提交的写操作被再次 begin 后仍保持 committed（不得被降级成 pending）',
    view.committed.some((item) => item.tool === 'write_file'),
    JSON.stringify(view.committed.map((i) => i.tool)));
  check('review：已完成的前台 shell 落在 unknown（不可从本地状态判断是否生效）',
    view.unknown.some((item) => item.tool === 'execute_shell'), JSON.stringify(view.unknown.map((i) => i.tool)));

  // 回归 #1：上面这条断言之所以一直绿，是因为第 81 行在 commit 之后**又调了一次 begin**，
  // 把 phase 从 committed 重置回 pending —— 那不是生产形态。生产里 shell 成功返回后，
  // 账本留下的是 phase==='committed' 的 unknown；旧实现会把它归进 committed（被当作「已提交的写」），
  // planResume 于是判 skippable，而执行期 begin() 只对 write 去重 → 命令被真的重跑一遍。
  const production = new SideEffectLedger({
    projectRoot: root,
    scopeRunId: 'prod-shape',
    file: path.join(root, '.codenode', 'runs', 'prod-shape.side-effects.json'),
  });
  const prodShell = production.begin('execute_shell', { command: 'npm publish' });
  production.commit(prodShell, { ok: true, result: 'published' });
  const prodView = production.review();
  check(
    '生产形态（begin→commit 后不再 begin）：已成功提交的 shell 必须落在 unknown 而非 committed',
    prodView.unknown.some((item) => item.tool === 'execute_shell' && item.phase === 'committed') &&
      !prodView.committed.some((item) => item.tool === 'execute_shell'),
    JSON.stringify({ committed: prodView.committed.map((i) => i.tool), unknown: prodView.unknown.map((i) => i.tool) })
  );
  check('review：提交失败的写操作落在 pending（未提交 → 续跑需人工复核）',
    view.pending.some((item) => item.tool === 'write_file'), JSON.stringify(view.pending.map((i) => i.tool)));

  // ---- (4) 账本损坏：宁可少去重，也不能伪造去重 ----
  const bad = path.join(root, '.codenode', 'runs', 'broken.side-effects.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{ this is not json');
  const broken = new SideEffectLedger({ projectRoot: root, scopeRunId: 'broken', file: bad });
  check('账本损坏：不伪造去重（从空账本开始并记录 loadError）',
    broken.size() === 0 && !!broken.loadError, String(broken.loadError || ''));

  // ---- (5) 回归 #4：虚假成功 —— 「已提交」不等于「现在的世界还是那样」 ----
  // save_project 的参数是空的（幂等键恒同），画布改过以后第二次调用会被去重跳过，
  // 却返回 ok:true → 用户看到「已保存」，而磁盘上还是旧版本。
  const saveLedger = new SideEffectLedger({
    projectRoot: root,
    scopeRunId: 'r-save',
    file: path.join(root, '.codenode', 'runs', 'r-save.side-effects.json'),
  });
  const save1 = saveLedger.begin('save_project', {}, {}, { idempotent: true });
  saveLedger.commit(save1, { ok: true });
  const save2 = saveLedger.begin('save_project', {}, {}, { idempotent: true });
  check(
    '[#4] 空参数的幂等写（save_project）第二次不得被跳过（否则报「已保存」但没写）',
    save2.skip === false,
    JSON.stringify({ skip: save2.skip })
  );

  // 带 path 的写：目标状态与提交后一致 → **仍然去重**（修 #4 不能把续跑去重一起废掉）
  const writeLedger = new SideEffectLedger({
    projectRoot: root,
    scopeRunId: 'r-write',
    file: path.join(root, '.codenode', 'runs', 'r-write.side-effects.json'),
  });
  const target4 = path.join(root, 'idem4-a.txt');
  const write1 = writeLedger.begin('write_file', { path: 'idem4-a.txt', content: 'X' }, {}, { idempotent: true });
  fs.writeFileSync(target4, 'X'); // 模拟工具真的写了
  writeLedger.commit(write1, { ok: true });
  const write2 = writeLedger.begin('write_file', { path: 'idem4-a.txt', content: 'X' }, {}, { idempotent: true });
  check('[#4] 目标状态与提交后一致 → 仍然幂等跳过', write2.skip === true, JSON.stringify({ skip: write2.skip }));

  // 目标被外部改过（用 size 变化，避免 mtime 精度导致的抖动）→ 不得跳过
  fs.writeFileSync(target4, 'YYYY');
  const write3 = writeLedger.begin('write_file', { path: 'idem4-a.txt', content: 'X' }, {}, { idempotent: true });
  check(
    '[#4] 目标在提交后被改过 → 不得跳过（否则覆盖外部改动还报成功）',
    write3.skip === false,
    JSON.stringify({ skip: write3.skip })
  );

  // 向后兼容：旧账本里没有 postStateDigest 时，行为必须与旧版一致（仍然去重）
  const legacyFile = path.join(root, '.codenode', 'runs', 'r-legacy.side-effects.json');
  const legacy = new SideEffectLedger({ projectRoot: root, scopeRunId: 'r-legacy', file: legacyFile });
  const legacy1 = legacy.begin('write_file', { path: 'idem4-a.txt', content: 'X' });
  legacy.commit(legacy1, { ok: true });
  const legacyRaw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  legacyRaw.records.forEach((record) => {
    delete record.postStateDigest;
  });
  fs.writeFileSync(legacyFile, JSON.stringify(legacyRaw));
  const legacy2 = new SideEffectLedger({ projectRoot: root, scopeRunId: 'r-legacy', file: legacyFile });
  const legacySkip = legacy2.begin('write_file', { path: 'idem4-a.txt', content: 'X' }).skip;
  check('[#4] 旧账本（无 postStateDigest）行为不变：仍然去重（向后兼容）', legacySkip === true, JSON.stringify({ skip: legacySkip }));

  // ---- (6) 回归 #13：只读工具不得触发账本全量落盘（O(n²) 主进程阻塞） ----
  // begin/commit 对**每个**工具调用都会整本 JSON 化 + fsync + rename；只读工具既不产生副作用、
  // 也不参与续跑去重，却照样付这个代价 → 单 Run 写出字节数约 O(n²)，全在同步路径上。
  const ioFile = path.join(root, '.codenode', 'runs', 'r-io.side-effects.json');
  const ioLedger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'r-io', file: ioFile });
  const readTok = ioLedger.begin('read_file', { path: 'a.txt' });
  ioLedger.commit(readTok, { ok: true, result: 'x' });
  check('[#13] 只读工具（read）不落盘：账本文件不应被创建', !fs.existsSync(ioFile), 'exists=' + fs.existsSync(ioFile));
  check(
    '[#13] 只读记录仍留在内存里供 review() 使用（只是不付 fsync）',
    ioLedger.review().committed.some((item) => item.tool === 'read_file'),
    JSON.stringify(ioLedger.review().committed.map((i) => i.tool))
  );
  const writeTok = ioLedger.begin('write_file', { path: 'io.txt', content: '1' });
  ioLedger.commit(writeTok, { ok: true, result: 'x' });
  check('[#13] 写操作照旧同步落盘（崩溃恢复要用的那条路径不能省）', fs.existsSync(ioFile), 'exists=' + fs.existsSync(ioFile));

  // ---- (7) 回归 #15：账本里的错误原文必须脱敏 ----
  const secretFile = path.join(root, '.codenode', 'runs', 'r-secret.side-effects.json');
  const secretLedger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'r-secret', file: secretFile });
  const secretTok = secretLedger.begin('write_file', { path: 'sec.txt', content: '1' });
  secretLedger.fail(secretTok, new Error('upload failed: Authorization: Bearer sk-abcdefghijklmnop123456'));
  const secretRaw = fs.readFileSync(secretFile, 'utf8');
  check('[#15] 账本落盘的错误原文不得含明文凭据', !secretRaw.includes('sk-abcdefghijklmnop123456'), secretRaw.slice(0, 160));
  check('[#15] 脱敏后仍保留可归因的错误信息', /upload failed/.test(secretRaw), secretRaw.slice(0, 160));

  console.log(failures === 0 ? 'SIDE EFFECT IDEMPOTENCY TEST: PASS' : 'SIDE EFFECT IDEMPOTENCY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SIDE EFFECT IDEMPOTENCY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
