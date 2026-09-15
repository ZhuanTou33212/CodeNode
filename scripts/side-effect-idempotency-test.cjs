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
  check('review：提交失败的写操作落在 pending（未提交 → 续跑需人工复核）',
    view.pending.some((item) => item.tool === 'write_file'), JSON.stringify(view.pending.map((i) => i.tool)));

  // ---- (4) 账本损坏：宁可少去重，也不能伪造去重 ----
  const bad = path.join(root, '.codenode', 'runs', 'broken.side-effects.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{ this is not json');
  const broken = new SideEffectLedger({ projectRoot: root, scopeRunId: 'broken', file: bad });
  check('账本损坏：不伪造去重（从空账本开始并记录 loadError）',
    broken.size() === 0 && !!broken.loadError, String(broken.loadError || ''));

  console.log(failures === 0 ? 'SIDE EFFECT IDEMPOTENCY TEST: PASS' : 'SIDE EFFECT IDEMPOTENCY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SIDE EFFECT IDEMPOTENCY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
