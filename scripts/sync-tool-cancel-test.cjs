/**
 * sync-tool-cancel-test.cjs —— 同步遍历工具的取消检查点（P7）
 *
 * 缺口（审查 §3 P1「同步工具不可取消」/ §7 待补测试）：`read_file` / `scan_project` /
 * `find_files` / `search_files` 都是**同步 fs 遍历**，用户在扫描大目录时点「停止」，
 * 工具仍会把整个项目走完才返回 —— 取消只在工具之间被检查，工具内部没有检查点。
 *
 * 修法：`impl/shared.cjs` 的 `isCancelled(context)` + 三个遍历循环里的检查点，
 * 取消时返回 `kind=failure / code=CANCELLED` 并如实说明「结果不完整」。
 *
 * 边界（如实写进测试，别假装已经解决）：单次同步 fs 调用（一次 readFileSync 大文件）
 * 依旧不可打断 —— 真正的可中断需要把工具挪到 worker/子进程，那部分**仍未做**。
 *
 * 判据：取消后必须 (a) 返回 CANCELLED，(b) 没被遍历完（partial < 完整结果数），
 * (c) 恢复不取消时结果完整（防止过度修复把工具改成永远只扫一部分）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-cancel-'));
// 造一个「够大」的项目：8 个目录 × 25 个文件 = 200 个文件（遍历里有 200+ 次检查点）
const DIRS = 8;
const FILES_PER_DIR = 25;
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

/**
 * 计数式取消信号：每读一次 `aborted` 就自增，超过阈值后返回 true。
 * 这样「取消」在**同步循环内部**真的会发生（setTimeout 在同步循环里根本排不上队，
 * 用它测同步遍历会永远测不到取消）。
 */
function countingSignal(afterChecks) {
  let reads = 0;
  const signal = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(signal, 'aborted', {
    get() {
      reads += 1;
      return reads > afterChecks;
    },
    configurable: true,
  });
  return signal;
}

function registry() {
  return toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    toolsAllowed: ['find_files', 'search_files', 'scan_project'],
  });
}

function context(signal) {
  return new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal,
  });
}

const CANCELLED_AFTER = 20;

(async () => {
  // ======================= 不取消：结果必须完整（防过度修复的对照） =======================
  {
    const live = new AbortController().signal;
    const files = await registry().execute('find_files', { pattern: '**/*.txt', maxResults: 500 }, context(live));
    const searched = await registry().execute('search_files', { pattern: 'needle', maxResults: 500 }, context(live));
    const scanned = await registry().execute('scan_project', {}, context(live));
    check('0a 不取消时 find_files 扫全 200 个文件',
      files.ok === true && files.data.count === TOTAL_FILES, JSON.stringify({ ok: files.ok, count: files.data && files.data.count }));
    check('0b 不取消时 search_files 扫全 200 处匹配',
      searched.ok === true && searched.data.count === TOTAL_FILES, JSON.stringify({ ok: searched.ok, count: searched.data && searched.data.count }));
    check('0c 不取消时 scan_project 扫全且未标记 stopped',
      scanned.ok === true && scanned.data.fileCount === TOTAL_FILES && scanned.data.stopped === undefined,
      JSON.stringify({ ok: scanned.ok, fileCount: scanned.data && scanned.data.fileCount }));
  }

  // ======================= find_files =======================
  {
    const res = await registry().execute('find_files', { pattern: '**/*.txt', maxResults: 500 }, context(countingSignal(CANCELLED_AFTER)));
    check('1a find_files 取消后返回 CANCELLED（不是「找到一部分」的成功）',
      res.ok === false && res.data.code === 'CANCELLED' && res.data.cancelled === true,
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('1b find_files 确实中途停了（partial < 完整结果）',
      typeof res.data.partial === 'number' && res.data.partial < TOTAL_FILES,
      JSON.stringify({ partial: res.data.partial, total: TOTAL_FILES }));
    check('1c 文案明确说明结果不完整', /不完整/.test(String(res.text)), String(res.text).slice(0, 60));
  }

  // ======================= search_files =======================
  {
    const res = await registry().execute('search_files', { pattern: 'needle', maxResults: 500 }, context(countingSignal(CANCELLED_AFTER)));
    check('2a search_files 取消后返回 CANCELLED',
      res.ok === false && res.data.code === 'CANCELLED', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('2b search_files 确实中途停了（partial < 完整结果）',
      typeof res.data.partial === 'number' && res.data.partial < TOTAL_FILES,
      JSON.stringify({ partial: res.data.partial, total: TOTAL_FILES }));
  }

  // ======================= scan_project =======================
  {
    const res = await registry().execute('scan_project', {}, context(countingSignal(CANCELLED_AFTER)));
    check('3a scan_project 取消后返回 CANCELLED',
      res.ok === false && res.data.code === 'CANCELLED', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('3b scan_project 确实中途停了（partial < 完整文件数）',
      typeof res.data.partial === 'number' && res.data.partial < TOTAL_FILES,
      JSON.stringify({ partial: res.data.partial, total: TOTAL_FILES }));
    check('3c scan_project 取消时没有把半份结果写回画布',
      fs.existsSync(path.join(root, 'workflow.cnode')) === false);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('SYNC TOOL CANCEL TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('SYNC TOOL CANCEL TEST: ERROR', e);
  process.exit(1);
});
