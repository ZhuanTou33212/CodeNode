/**
 * fs-worker-test.cjs —— 文件遍历任务跑在 worker 线程里（P7 收口）
 *
 * 为什么这事必须验到底：把遍历搬进 worker 有两个**收益**（真可中断、不阻塞主进程）和两个
 * **易漏的坑**（打包后 worker 路径在 asar 里加载不了；worker 不可用时若无降级就等于工具全废，
 * 而若降级了却不留痕就等于「已搬到 worker」成了纸面结论）。逐条锁住：
 *
 *   A. worker 模式：三个任务都能跑，且结果与同步实现**逐字节一致**（单一实现来源的意义）；
 *   B. 取消：`terminate` 真的杀掉任务（含同步 fs 中途），如实回报「没跑完」；
 *   C. 降级：worker 入口不可用时**显式**退回主线程同步执行，结果仍正确且带原因；
 *   D. 降级留痕：工具层把它写进 audit 与 data（不静默退回旧的阻塞行为）；
 *   E. 打包路径：asar 内路径会被重写到 `app.asar.unpacked`；
 *   F. 打包配置：`build.asarUnpack` 确实包含这两个文件（漏了只有打包版才炸，CI 看不出来）；
 *   G. 可克隆性：含函数的 payload 下发给 worker 前被剥掉（否则 postMessage 抛 DataCloneError）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fsCore = require('../electron/tools/fsCore.cjs');
const fsRunner = require('../electron/tools/fsRunner.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-fsworker-'));
// 混合结构：源码 / 资产 / 忽略目录 / 敏感文件 / 大文件 —— 让「结果一致」这条有真实的判别力
const dirs = ['src', 'src/lib', 'assets', 'node_modules/pkg', 'docs'];
for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\nneedle\n', 'utf8');
fs.writeFileSync(path.join(root, 'src', 'lib', 'b.js'), 'needle line\nconst b = 2;\nneedle again\n', 'utf8');
fs.writeFileSync(path.join(root, 'docs', 'readme.md'), '# title\nneedle\n', 'utf8');
fs.writeFileSync(path.join(root, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'needle in ignored dir\n', 'utf8');
fs.writeFileSync(path.join(root, '.env'), 'SECRET=needle\n', 'utf8');
fs.writeFileSync(path.join(root, 'big.txt'), 'needle\n' + 'x'.repeat(5000) + '\n', 'utf8');

const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
sandbox.setDefaultPolicy(policy);

/**
 * 造一个「够大」的目录树。取消 / 进度类判据都依赖「任务真的持续了一段时间」：
 * 小 fixture（几个文件）上任务可能在 abort 之前就跑完，判据退化成「谁快」的时序竞争
 * —— macOS 上实测因此红过一次（Windows 本地反而稳定通过）。所以这里统一用大目录。
 */
const BIG_DIRS = 12;
const BIG_FILES_PER_DIR = 50;
const BIG_TOTAL = BIG_DIRS * BIG_FILES_PER_DIR;
function makeBigTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-fsworker-big-'));
  for (let d = 0; d < BIG_DIRS; d++) {
    const sub = path.join(dir, 'd' + d);
    fs.mkdirSync(sub, { recursive: true });
    for (let f = 0; f < BIG_FILES_PER_DIR; f++) {
      fs.writeFileSync(path.join(sub, 'f' + f + '.txt'), 'needle ' + d + '-' + f + '\n', 'utf8');
    }
  }
  return dir;
}

/** 三个任务的 payload（不含函数，供一致性比对用） */
const PAYLOADS = {
  scanProject: { root },
  findFiles: { root, pattern: '**/*', limit: 1000 },
  searchFiles: { root, start: root, pattern: 'needle', maxCollect: 1000 },
};

(async () => {
  // ======================= A. worker 模式 + 与同步实现逐字节一致 =======================
  {
    for (const task of fsCore.FS_TASKS) {
      const outcome = await fsRunner.runFsTask(task, PAYLOADS[task], {});
      const syncResult = fsCore.runTaskSync(task, PAYLOADS[task]);
      check('A1 ' + task + ' 在 worker 模式下跑完',
        outcome.ok === true && outcome.mode === 'worker',
        JSON.stringify({ ok: outcome.ok, mode: outcome.mode, reason: outcome.fallbackReason }));
      check('A2 ' + task + ' worker 结果与同步实现逐字节一致',
        JSON.stringify(outcome.result) === JSON.stringify(syncResult),
        JSON.stringify(outcome.result).slice(0, 120));
    }
    const scanned = await fsRunner.runFsTask('scanProject', PAYLOADS.scanProject, {});
    check('A3 忽略目录/二进制分类与旧实现一致（node_modules 不进、png 归资产）',
      scanned.result.files.every((f) => !f.relPath.startsWith('node_modules/')) &&
        scanned.result.assetFiles.some((f) => f.name === 'logo.png'),
      JSON.stringify({ files: scanned.result.files.map((f) => f.relPath), assets: scanned.result.assetFiles.map((f) => f.name) }));
    check('A4 语言统计用得到元信息（ts/js/md 被识别）',
      ['typescript', 'javascript', 'markdown'].every((lang) => scanned.result.sourceFiles.some((f) => f.language === lang)),
      JSON.stringify(scanned.result.sourceFiles.map((f) => f.relPath + ':' + f.language)));
  }

  // ======================= B. 取消：terminate 真的杀掉任务 =======================
  {
    const big = makeBigTree();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const outcome = await fsRunner.runFsTask('scanProject', { root: big }, { signal: controller.signal });
    check('B1 取消后 outcome.cancelled=true（不重放已取消的任务）',
      outcome.cancelled === true && outcome.ok === false, JSON.stringify({ ok: outcome.ok, cancelled: outcome.cancelled }));
    check('B2 取消时如实回报进度（partial 是数字，且小于完整数量）',
      typeof outcome.progress === 'number' && outcome.progress < BIG_TOTAL, JSON.stringify({ progress: outcome.progress }));
    check('B3 取消路径没有被误判成「worker 故障」而降级重跑',
      outcome.mode === 'worker' && !outcome.fallbackReason, JSON.stringify({ mode: outcome.mode, fallbackReason: outcome.fallbackReason }));
    fs.rmSync(big, { recursive: true, force: true });
  }

  // ======================= C/D. 降级：worker 不可用时显式退回同步 + 留痕 =======================
  {
    const workerPath = fsRunner.workerFilePath();
    const hidden = workerPath + '.hidden-for-test';
    fs.renameSync(workerPath, hidden);
    try {
      const outcome = await fsRunner.runFsTask('scanProject', PAYLOADS.scanProject, {});
      check('C1 worker 入口缺失时显式降级（mode=sync-fallback 且带原因）',
        outcome.ok === true && outcome.mode === 'sync-fallback' && /worker/.test(String(outcome.fallbackReason)),
        JSON.stringify({ mode: outcome.mode, reason: outcome.fallbackReason }));
      check('C2 降级后结果仍然正确（工具不能因为 worker 缺失就不可用）',
        JSON.stringify(outcome.result) === JSON.stringify(fsCore.runTaskSync('scanProject', PAYLOADS.scanProject)),
        JSON.stringify(outcome.result).slice(0, 120));

      // D：工具层必须把降级写进 audit 与 data，不能悄悄退回旧的阻塞行为
      const audits = [];
      const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['scan_project'] });
      const ctx = new AgentToolContext({
        projectRoot: root,
        confirm: async () => true,
        audit: (entry) => audits.push(String(entry)),
        sandbox: policy,
        signal: new AbortController().signal,
      });
      const res = await registry.execute('scan_project', {}, ctx);
      check('D1 降级在工具结果里留痕（data.workerMode=sync-fallback + workerFallback）',
        res.ok === true && res.data.workerMode === 'sync-fallback' && typeof res.data.workerFallback === 'string',
        JSON.stringify({ ok: res.ok, workerMode: res.data && res.data.workerMode, fallback: res.data && res.data.workerFallback }));
      check('D2 降级写进审计（可事后归因，不静默）',
        audits.some((a) => /worker/.test(a) && /退回主线程/.test(a)),
        JSON.stringify(audits));
    } finally {
      // 无论如何都要把 worker 入口放回去，否则后续用例/生产都会退化成降级路径
      if (fs.existsSync(hidden)) fs.renameSync(hidden, workerPath);
    }
    const restored = await fsRunner.runFsTask('scanProject', PAYLOADS.scanProject, {});
    check('C3 还原后重新走 worker（降级不是一次性粘住的状态）', restored.mode === 'worker', String(restored.mode));
  }

  // ======================= E. 打包路径：asar → asar.unpacked =======================
  {
    const base = path.join('C:', 'app', 'resources', 'app.asar', 'electron', 'tools');
    const p = fsRunner.workerFilePath(base);
    check('E1 asar 内路径被重写到 app.asar.unpacked（worker_threads 需要真实文件系统）',
      p.includes('app.asar.unpacked') && !/app\.asar[\\/]electron/.test(p), p);
    const already = fsRunner.workerFilePath(path.join('C:', 'app', 'resources', 'app.asar.unpacked', 'electron', 'tools'));
    check('E2 已经是 unpacked 的路径不重复替换', already.includes('unpacked') && !already.includes('unpacked.unpacked'), already);
    const dev = fsRunner.workerFilePath(path.join('E:', 'CodeNode', 'electron', 'tools'));
    check('E3 开发模式（无 asar）路径原样返回', !dev.includes('unpacked'), dev);
  }

  // ======================= F. 打包配置：asarUnpack 必须包含这两个文件 =======================
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const unpack = (pkg.build && pkg.build.asarUnpack) || [];
    const list = Array.isArray(unpack) ? unpack : [unpack];
    const joined = JSON.stringify(list);
    check('F1 build.asarUnpack 包含 fsWorker.cjs（漏了只有打包版才炸，CI 看不出来）',
      joined.includes('fsWorker.cjs'), joined);
    check('F2 build.asarUnpack 包含 fsCore.cjs（worker 只能 require 同样被 unpack 的兄弟文件）',
      joined.includes('fsCore.cjs'), joined);
    check('F2b build.asarUnpack 包含 impl/pdfText.cjs（fsCore 现在 require 它，漏了打包版 MODULE_NOT_FOUND）',
      joined.includes('pdfText.cjs'), joined);
    check('F3 build.files 仍包含 electron/**（unpack 只是额外解包，不影响打包清单）',
      JSON.stringify(pkg.build.files || []).includes('electron/**'), JSON.stringify(pkg.build.files));
  }

  // ======================= G. 可克隆性 =======================
  {
    const payload = { root, shouldStop: () => true, limit: 5 };
    const clonable = fsRunner.clonablePayload(payload);
    check('G1 下发给 worker 的 payload 剥掉了函数（否则 postMessage 抛 DataCloneError）',
      clonable.root === root && clonable.limit === 5 && !('shouldStop' in clonable), JSON.stringify(clonable));
    const outcome = await fsRunner.runFsTask('findFiles', payload, {});
    check('G2 带函数的 payload 也能正常跑（剥函数发生在 runner 内部）',
      outcome.ok === true && outcome.mode === 'worker', JSON.stringify({ ok: outcome.ok, mode: outcome.mode }));
  }

  // ======================= H. project_info / analyze_project（工程信息识别）=======================
  {
    const projectScan = require('../electron/tools/projectScan.cjs');
    const registry = toolkit.buildDefaultRegistryWithConfig({
      projectRoot: root,
      ragEnabled: false,
      toolsAllowed: ['project_info', 'analyze_project'],
    });
    const ctx = () =>
      new AgentToolContext({
        projectRoot: root,
        confirm: async () => true,
        audit: () => {},
        sandbox: policy,
        signal: new AbortController().signal,
      });

    // H1/H2：语言统计回归锁 —— 旧实现把 scan().files（只有 relPath/absPath/size）传给
    // languageSummary，导致 languages 恒为 {"undefined": <文件数>}。fixture 里有 .ts/.js/.md。
    const info = await registry.execute('project_info', {}, ctx());
    check('H1 project_info 的语言分布不再是 {"undefined": N}（旧 bug 回归锁）',
      info.ok === true && !('undefined' in info.data.languages) && (info.data.languages.typescript || 0) >= 1,
      JSON.stringify(info.data && info.data.languages));
    check('H2 project_info 走 worker（没悄悄退回主线程）', info.data.workerMode === 'worker', String(info.data.workerMode));

    const analyzed = await registry.execute('analyze_project', {}, ctx());
    check('H3 analyze_project 语言摘要同样正常 + 带逐文件结构摘要',
      analyzed.ok === true && !('undefined' in analyzed.data.languageSummary) &&
        Array.isArray(analyzed.data.fileAnalysis) && analyzed.data.fileAnalysis.length > 0,
      JSON.stringify({ langs: analyzed.data && analyzed.data.languageSummary, analyzed: analyzed.data && analyzed.data.analyzedFileCount }));
    check('H4 analyze_project 也走 worker', analyzed.data.workerMode === 'worker', String(analyzed.data.workerMode));

    // H5：**遍历次数**才是「只扫一遍」的判据 —— 旧路径是 detectProjectInfo + scan 各一遍。
    const realReaddir = fs.readdirSync;
    let calls = 0;
    fs.readdirSync = (...a) => {
      calls += 1;
      return realReaddir.apply(fs, a);
    };
    let once = 0;
    let twice = 0;
    try {
      calls = 0;
      fsCore.runTaskSync('analyzeProject', { root, limit: 5 });
      once = calls;
      calls = 0;
      projectScan.detectProjectInfo(root);
      projectScan.scan(root);
      twice = calls;
    } finally {
      fs.readdirSync = realReaddir;
    }
    check('H5 新实现只遍历一次（旧路径 detectProjectInfo+scan 是两次）',
      once > 0 && twice > once, JSON.stringify({ once, twice }));

    // H6：任务层一致性（worker vs 同步逐字节）
    for (const task of ['detectProjectInfo', 'analyzeProject']) {
      const payload = task === 'detectProjectInfo' ? { root } : { root, limit: 50 };
      const viaWorker = await fsRunner.runFsTask(task, payload, {});
      const viaSync = fsCore.runTaskSync(task, payload);
      check('H6 ' + task + ' worker 与同步结果逐字节一致',
        JSON.stringify(viaWorker.result) === JSON.stringify(viaSync),
        JSON.stringify(viaWorker.result).slice(0, 100));
    }

    // H7：可取消（terminate）—— 必须用**大目录**：小 fixture 上任务可能在 abort 之前就跑完，
    // 判据会退化成「谁快」的时序竞争（macOS 上实测因此红过一次，Windows 本地反而稳定）。
    const bigForCancel = makeBigTree();
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const cancelledOutcome = await fsRunner.runFsTask('detectProjectInfo', { root: bigForCancel }, { signal: controller.signal });
      check('H7 detectProjectInfo 能被 terminate 取消（不是只能等它跑完）',
        cancelledOutcome.cancelled === true,
        JSON.stringify({ cancelled: cancelledOutcome.cancelled, progress: cancelledOutcome.progress }));
    } finally {
      fs.rmSync(bigForCancel, { recursive: true, force: true });
    }
  }

  // ======================= I. read_file 的 PDF 分支（唯一搬进 worker 的单文件读）=======================
  {
    const zlib = require('zlib');

    /** 造一个「最小可解析」的文本型 PDF：content stream 里用 Tj 写字面文本 */
    const makePdf = (bodyText, { withBT = true } = {}) => {
      const content = withBT ? 'BT /F1 12 Tf 50 700 Td (' + bodyText + ') Tj ET' : '<< /Type /Page >>';
      const deflated = zlib.deflateSync(Buffer.from(content, 'latin1'));
      const head = '%PDF-1.4\n1 0 obj\n<< /Length ' + deflated.length + ' /Filter /FlateDecode >>\nstream\n';
      const tail = '\nendstream\nendobj\n';
      return Buffer.concat([Buffer.from(head, 'latin1'), deflated, Buffer.from(tail, 'latin1')]);
    };

    const pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-pdf-'));
    fs.writeFileSync(path.join(pdfDir, 'ok.pdf'), makePdf('Hello CodeNode PDF text layer. '.repeat(6)));
    fs.writeFileSync(path.join(pdfDir, 'scanned.pdf'), makePdf('', { withBT: false }));
    fs.writeFileSync(path.join(pdfDir, 'huge.pdf'), Buffer.alloc(20 * 1024 * 1024 + 16, 0x20));
    // 「小文件但解析慢」：原始文本流很大（deflate 后仍很小），解析需要上百毫秒 —— 心跳与取消才稳
    // 规模是量出来的：8.58MB 文本流解析成功且耗时 ~150ms（够慢，心跳稳），
    // 而且这正是**旧实现爆栈、被误报成「扫描版」**的规模 —— 这条同时是那次修复的回归锁。
    fs.writeFileSync(path.join(pdfDir, 'slow.pdf'), makePdf('the quick brown fox jumps over the lazy dog. '.repeat(200000)));

    const pdfRegistry = toolkit.buildDefaultRegistryWithConfig({
      projectRoot: pdfDir,
      ragEnabled: false,
      toolsAllowed: ['read_file'],
    });
    const pdfCtx = () =>
      new AgentToolContext({
        projectRoot: pdfDir,
        confirm: async () => true,
        audit: () => {},
        sandbox: policy,
        signal: new AbortController().signal,
      });

    const okRes = await pdfRegistry.execute('read_file', { path: 'ok.pdf' }, pdfCtx());
    check('I1 PDF 文本层照常提取（走 worker）',
      okRes.ok === true && /Hello CodeNode PDF text layer/.test(String(okRes.text)),
      JSON.stringify(okRes.data).slice(0, 100));

    const scannedRes = await pdfRegistry.execute('read_file', { path: 'scanned.pdf' }, pdfCtx());
    check('I2 扫描版 PDF 仍给出「文字层不可用」的原有提示（文案未变）',
      scannedRes.ok === false && /文字层不可用/.test(String(scannedRes.text)),
      String(scannedRes.text).slice(0, 60));

    const hugeRes = await pdfRegistry.execute('read_file', { path: 'huge.pdf' }, pdfCtx());
    check('I3 超过 20MB 的 PDF 仍被拒（阈值与文案未变）',
      hugeRes.ok === false && /PDF 过大（>20MB）/.test(String(hugeRes.text)),
      String(hugeRes.text).slice(0, 60));

    // I4：任务层 worker 与同步结果逐字节一致
    const syncPdf = fsCore.runTaskSync('readPdfText', { path: path.join(pdfDir, 'ok.pdf') });
    const workerPdf = await fsRunner.runFsTask('readPdfText', { path: path.join(pdfDir, 'ok.pdf') }, {});
    check('I4 readPdfText worker 与同步结果逐字节一致',
      workerPdf.mode === 'worker' && JSON.stringify(workerPdf.result) === JSON.stringify(syncPdf),
      JSON.stringify({ mode: workerPdf.mode, same: JSON.stringify(workerPdf.result) === JSON.stringify(syncPdf) }));

    // I5：解析期间主线程事件循环仍在跳（慢 PDF：解析 ~百毫秒）
    let ticks = 0;
    const hb = setInterval(() => {
      ticks += 1;
    }, 3);
    let slowRes = null;
    try {
      slowRes = await pdfRegistry.execute('read_file', { path: 'slow.pdf' }, pdfCtx());
    } finally {
      clearInterval(hb);
    }
    check('I5 PDF 解析期间主线程事件循环仍在跳（同步实现下 ticks 必为 0）', ticks > 0, 'ticks=' + ticks);
    check('I6 慢 PDF 也照常解析成功（不是靠牺牲功能换的）', slowRes.ok === true, String(slowRes.text).slice(0, 40));

    // I7：可取消（确定性触发：一开始就 aborted，不依赖"解析比定时器慢"的竞争）
    const preAborted = new AbortController();
    preAborted.abort();
    const cancelRes = await pdfRegistry.execute('read_file', { path: 'slow.pdf' }, new AgentToolContext({
      projectRoot: pdfDir,
      confirm: async () => true,
      audit: () => {},
      sandbox: policy,
      signal: preAborted.signal,
    }));
    check('I7 取消后返回 CANCELLED（不再等解析跑完）',
      cancelRes.ok === false && cancelRes.data.code === 'CANCELLED',
      JSON.stringify({ ok: cancelRes.ok, code: cancelRes.data && cancelRes.data.code }));

    fs.rmSync(pdfDir, { recursive: true, force: true });
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('FS WORKER TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FS WORKER TEST: ERROR', e);
  process.exit(1);
});
