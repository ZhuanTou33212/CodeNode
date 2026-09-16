/**
 * sync-tool-cancel-test.cjs —— 文件遍历工具的取消与「不阻塞主线程」（P7 收口版）
 *
 * 演进过程（两版判据都留在这里，因为它们证明的是**不同**的东西）：
 *   第一版：遍历工具在**循环之间**加取消检查点。判据用「计数式 aborted getter」——
 *           因为同步循环里 `setTimeout` 排不上队，用真 AbortSignal 永远测不到取消。
 *   收口版：遍历整体搬进 **worker 线程**，取消改为 `worker.terminate()` —— 连**单次同步 fs 调用**
 *           中途也能杀掉。判据随之变硬：用**真 AbortSignal + 主线程 setTimeout 触发**。
 *           同步实现下遍历会占满事件循环，那个 setTimeout 根本轮不到执行 → 取消不生效。
 *           所以「取消真的生效」这条本身，同时证明了「主线程没有被遍历占住」。
 *
 * 另外两条对照：
 *   - 不取消 → 结果必须完整（防过度修复把工具改成永远只扫一部分）；
 *   - `tools.fs_worker=false`（显式同步）时，取消仍由循环检查点生效（信号一开始就是 aborted）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const fsRunner = require('../electron/tools/fsRunner.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-cancel-'));
// 造一个「够大」的项目：8 个目录 × 75 个文件 = 600 个文件。
// 规模不能太小：心跳与取消两条判据都依赖「遍历真的持续了一段时间」，
// 200 个文件的遍历在 worker 里可能只花几毫秒，判据会变成碰运气。
const DIRS = 8;
const FILES_PER_DIR = 75;
for (let d = 0; d < DIRS; d++) {
  const dir = path.join(root, 'd' + d);
  fs.mkdirSync(dir, { recursive: true });
  for (let f = 0; f < FILES_PER_DIR; f++) {
    fs.writeFileSync(path.join(dir, 'f' + f + '.txt'), 'needle ' + d + '-' + f + '\n', 'utf8');
  }
}
const TOTAL_FILES = DIRS * FILES_PER_DIR;

const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
sandbox.setDefaultPolicy(policy);

function registry() {
  return toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    toolsAllowed: ['find_files', 'search_files', 'scan_project'],
  });
}

/** @param {AbortSignal|null} signal @param {boolean} [fsWorker] */
function context(signal, fsWorker = true) {
  return new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal,
    fsWorker: fsWorker !== false,
  });
}

/** 在 N 毫秒后 abort（worker 是独立线程，主线程的定时器**能**在遍历期间执行） */
function abortAfter(controller, ms) {
  setTimeout(() => controller.abort(), ms);
}

(async () => {
  check('前置：worker 入口文件存在（打包漏配 asarUnpack 会让下面全部退化）', fsRunner.workerAvailable() === true, fsRunner.workerFilePath());

  // ======================= 0. 不取消：结果必须完整 =======================
  {
    const live = new AbortController().signal;
    const files = await registry().execute('find_files', { pattern: '**/*.txt', maxResults: 1000 }, context(live));
    const searched = await registry().execute('search_files', { pattern: 'needle', maxResults: 1000 }, context(live));
    const scanned = await registry().execute('scan_project', {}, context(live));
    check('0a 不取消时 find_files 扫全全部文件', files.ok === true && files.data.count === TOTAL_FILES,
      JSON.stringify({ ok: files.ok, count: files.data && files.data.count }));
    check('0b 不取消时 search_files 扫全全部匹配', searched.ok === true && searched.data.count === TOTAL_FILES,
      JSON.stringify({ ok: searched.ok, count: searched.data && searched.data.count }));
    check('0c 不取消时 scan_project 扫全且未标记 stopped',
      scanned.ok === true && scanned.data.fileCount === TOTAL_FILES && scanned.data.stopped === undefined,
      JSON.stringify({ ok: scanned.ok, fileCount: scanned.data && scanned.data.fileCount }));
  }

  // ======================= 1. 取消：terminate 真的杀掉遍历 =======================
  {
    const c1 = new AbortController();
    abortAfter(c1, 20);
    const res = await registry().execute('find_files', { pattern: '**/*.txt', maxResults: 1000 }, context(c1.signal));
    check('1a find_files 取消后返回 CANCELLED（不是「找到一部分」的成功）',
      res.ok === false && res.data.code === 'CANCELLED' && res.data.cancelled === true,
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('1b find_files 结果不完整（partial < 完整结果，或至少如实标注）',
      typeof res.data.partial === 'number' && res.data.partial < TOTAL_FILES,
      JSON.stringify({ partial: res.data.partial, total: TOTAL_FILES }));
    check('1c 文案明确说明结果不完整', /不完整/.test(String(res.text)), String(res.text).slice(0, 60));
  }

  // ======================= 2. 主线程心跳：遍历期间事件循环仍在转 =======================
  {
    let ticks = 0;
    const hb = setInterval(() => {
      ticks += 1;
    }, 3);
    let scanned = null;
    try {
      scanned = await registry().execute('scan_project', {}, context(new AbortController().signal));
    } finally {
      clearInterval(hb);
    }
    check('2a 扫描期间主线程事件循环仍在跳（同步实现下 ticks 必为 0）', ticks > 0, 'ticks=' + ticks);
    check('2b 扫描结果照常正确（worker 不是靠牺牲功能换来的）',
      scanned.ok === true && scanned.data.fileCount === TOTAL_FILES, JSON.stringify({ ok: scanned.ok }));
    check('2c scan_project 结果里如实标注执行位置（worker 模式）',
      scanned.data.workerMode === 'worker', JSON.stringify({ workerMode: scanned.data.workerMode }));
  }

  // ======================= 3. 取消时的 partial 用进度回报 =======================
  {
    const c = new AbortController();
    abortAfter(c, 20);
    const res = await registry().execute('scan_project', {}, context(c.signal));
    check('3a scan_project 取消后返回 CANCELLED + partial 是数字',
      res.ok === false && res.data.code === 'CANCELLED' && typeof res.data.partial === 'number',
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code, partial: res.data.partial }));
    check('3b 取消时没有把半份结果写回画布', fs.existsSync(path.join(root, 'workflow.cnode')) === false);
  }

  // ======================= 4. 显式同步模式（tools.fs_worker=false）：循环检查点仍生效 =======================
  {
    const aborted = new AbortController();
    aborted.abort(); // 一开始就 aborted → 循环检查点第一次就命中（不依赖事件循环，同步模式下也确定）
    const res = await registry().execute('scan_project', {}, context(aborted.signal, false));
    check('4a 同步模式下取消仍生效（循环检查点）',
      res.ok === false && res.data.code === 'CANCELLED', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('4b 同步模式下结果同样标注「不完整」', /不完整/.test(String(res.text)), String(res.text).slice(0, 60));
  }

  // ======================= 5. project_info / analyze_project 同样跑在 worker =======================
  {
    const reg = toolkit.buildDefaultRegistryWithConfig({
      projectRoot: root,
      ragEnabled: false,
      toolsAllowed: ['project_info', 'analyze_project'],
    });
    let ticks = 0;
    const hb = setInterval(() => {
      ticks += 1;
    }, 3);
    let infoRes = null;
    try {
      infoRes = await reg.execute('project_info', {}, context(new AbortController().signal));
    } finally {
      clearInterval(hb);
    }
    check('5a project_info 期间主线程事件循环仍在跳（它同样要读全项目算行数）', ticks > 0, 'ticks=' + ticks);
    check('5b project_info 走 worker，且语言分布不含 undefined 键',
      infoRes.ok === true && infoRes.data.workerMode === 'worker' && !('undefined' in infoRes.data.languages),
      JSON.stringify({ mode: infoRes.data && infoRes.data.workerMode, langs: Object.keys((infoRes.data && infoRes.data.languages) || {}).slice(0, 4) }));

    const c9 = new AbortController();
    abortAfter(c9, 20);
    const cancelled = await reg.execute('analyze_project', {}, context(c9.signal));
    check('5c analyze_project 取消后返回 CANCELLED（不是等它跑完）',
      cancelled.ok === false && cancelled.data.code === 'CANCELLED',
      JSON.stringify({ ok: cancelled.ok, code: cancelled.data && cancelled.data.code }));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('SYNC TOOL CANCEL TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('SYNC TOOL CANCEL TEST: ERROR', e);
  process.exit(1);
});
