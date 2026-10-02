/**
 * worktree.cjs —— git worktree 隔离（对照 Codex / Claude Code 的「在独立工作树里改代码」）
 *
 * 短板（对照文档 §5 #7）：harness 里做「并行改代码」只有**结果合并**（`merge.cjs`）与子代理的工具权限约束，
 * 没有**文件系统层面**的隔离 —— 两个子代理同时改同一个仓库只能靠租约串行化，主代理在子代理干活期间
 * 碰过的文件同样会影响它。
 *
 * 这里补的是「工作树隔离」这一档：`git worktree` 建一份独立检出（独立分支、独立文件），
 * 子代理在其中改代码，主代理的工作树逐字节不受影响；改完由主代理决定合并还是丢弃。
 *
 * 约束（都不能省）：
 *   · 只在**受管目录** `.codenode/worktrees/<slug>` 下建/删（删受管目录之外的路径一律拒绝）；
 *   · 项目必须是 git 仓库（不是就如实报错，不假装隔离成功）；
 *   · 数量上限（默认 5）—— 工作树是磁盘副本，不设上限等于给磁盘埋雷；
 *   · 所有 git 命令走 `sandbox.guardedSpawn`（与 execute_shell / 钩子同一条隔离通道），
 *     有超时、有输出上限，且 `GIT_TERMINAL_PROMPT=0`（绝不因为等凭据输入而挂住）；
 *   · 一切失败都返回 `{ok:false, error, message}`，由调用方决定怎么呈现 —— 不抛。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const sandbox = require('./sandbox.cjs');
const shellTool = require('./tools/impl/executeShellTool.cjs');
const { safeEnvironment } = require('./envPolicy.cjs');

const MAX_WORKTREES = 5;
const GIT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_CHARS = 8000;
const worktreeCreationQueues = new Map();

/**
 * 路径归一化：realpath 展开 + Windows 大小写归一。
 *
 * 为什么必须有：`git worktree list --porcelain` 回的是 **8.3 短路径**（CI 的
 * `C:\Users\RUNNER~1\AppData\Local\Temp\...`），而我们的 root 是长路径 ——
 * 直接 `path.relative` 会算出 `..\..\..`，于是「受管工作树」判定全空：
 * 本地（长路径）全绿、CI 全红（2026-09-21 实测）。realpath 把短名展开成长名，大小写再归一到小写。
 */
function normalizePath(target) {
  let out = path.resolve(String(target || '.'));
  try {
    out = fs.realpathSync.native(out);
  } catch {
    // 不存在的路径（还没建出来）→ 用 resolve 结果
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** target 是否落在受管目录（`.codenode/worktrees/`）之内 */
function isManagedPath(projectRoot, target) {
  const rel = path.relative(normalizePath(worktreesRoot(projectRoot)), normalizePath(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function worktreesRoot(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'worktrees');
}

/** 分支/目录名归一化：只留安全字符，避免把路径搞出受管目录 */
function slugify(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'task-' + Date.now().toString(36);
}

/**
 * 跑一条 git 命令（走统一隔离层）。
 * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string, stderr: string, timedOut?: boolean, error?: string}>}
 */
async function runGit(projectRoot, args, options) {
  const opts = /** @type {any} */ (options || {});
  const inRoot = path.resolve(projectRoot || '.');
  const policy = opts.policy || sandbox.currentPolicy(opts.context);
  let child;
  try {
    child = sandbox.guardedSpawn(
      { file: 'git', args: args.map(String) },
      shellTool.foregroundSpawnOptions(inRoot, safeEnvironment({ GIT_TERMINAL_PROMPT: '0' }, []), policy, opts.context)
    );
  } catch (error) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', error: 'SPAWN_FAILED: ' + String((error && error.message) || error) };
  }
  const collected = shellTool.makeOutputCollector();
  let timedOut = false;
  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      setTimeout(() => finish(null), 200);
    }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (data) => shellTool.pushCollected(collected, String(data)));
    child.stderr.on('data', (data) => shellTool.pushCollected(collected, String(data)));
    child.on('error', (error) => {
      shellTool.pushCollected(collected, 'ERROR ' + String((error && error.message) || error));
      finish(null);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
  });
  const text = shellTool.collectedText(collected);
  return {
    ok: !timedOut && exitCode === 0,
    exitCode,
    stdout: text.slice(0, MAX_OUTPUT_CHARS),
    stderr: timedOut ? 'TIMEOUT' : '',
    timedOut,
  };
}

async function isGitRepo(projectRoot, options) {
  const res = await runGit(projectRoot, ['rev-parse', '--is-inside-work-tree'], options);
  return res.ok && /true/.test(res.stdout);
}

async function currentBranch(projectRoot, options) {
  const res = await runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], options);
  if (!res.ok) return null;
  const head = res.stdout.trim();
  return head && head !== 'HEAD' ? head : null;
}

/** 已登记的工作树（含 git 自身的元信息） */
async function listWorktrees(projectRoot, options) {
  if (!(await isGitRepo(projectRoot, options))) return [];
  const res = await runGit(projectRoot, ['worktree', 'list', '--porcelain'], options);
  if (!res.ok) return [];
  const list = [];
  /** @type {{path: string, branch: string|null, head: string|null, detached: boolean}|null} */
  let current = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) list.push(current);
      current = { path: line.slice('worktree '.length).trim(), branch: null, head: null, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line.trim() === 'detached') current.detached = true;
  }
  if (current) list.push(current);
  return list;
}

/** 只认受管目录里的工作树（remove 的安全边界） */
async function managedWorktrees(projectRoot, options) {
  const all = await listWorktrees(projectRoot, options);
  // 用归一化后的比较：git 回的可能是 8.3 短路径、大小写也可能不同（见 normalizePath 注释）
  return all.filter((w) => isManagedPath(projectRoot, w.path));
}

/**
 * 建一份工作树。
 * @param {string} projectRoot
 * @param {{name?: string, base?: string|null}} options
 * @param {{context?: any, policy?: any}} [helpers] 隔离层所需的上下文/策略
 */
async function createWorktreeUnlocked(projectRoot, options, helpers) {
  const opts = /** @type {any} */ (Object.assign({}, options || {}, helpers || {}));
  const root = path.resolve(projectRoot || '.');
  if (!(await isGitRepo(root, opts))) {
    return { ok: false, error: 'NOT_A_GIT_REPO', message: '当前项目不是 git 仓库（没有 .git），无法建工作树：请先 git init，或改用非隔离方式' };
  }
  const base = String(opts.base || '').trim() || (await currentBranch(root, opts));
  if (!base) {
    return { ok: false, error: 'NO_BASE', message: '拿不到基线分支（HEAD 处于游离状态？）：请显式传 base' };
  }
  const existing = await managedWorktrees(root, opts);
  if (existing.length >= MAX_WORKTREES) {
    return {
      ok: false,
      error: 'TOO_MANY',
      message: '受管工作树已达上限 ' + MAX_WORKTREES + ' 个：请先移除不用的（action=remove）再建新的，避免磁盘副本无限增长',
      managed: existing.map((w) => path.basename(w.path)),
    };
  }
  const slug = slugify(opts.name);
  const target = path.join(worktreesRoot(root), slug);
  if (fs.existsSync(target)) {
    return { ok: false, error: 'EXISTS', message: '该名字的工作树已存在：' + path.relative(root, target) + '（换名字，或先移除它）', path: target };
  }
  const branch = 'codenode/' + slug;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 分支已存在（同名 slug 复用）时接上既有分支，避免「工作树建好了、分支却重名报错」
  const branches = await runGit(root, ['branch', '--list', branch], opts);
  const addArgs = branches.ok && branches.stdout.trim() ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target, base];
  const added = await runGit(root, addArgs, opts);
  if (!added.ok) {
    return { ok: false, error: 'GIT_FAILED', message: 'git worktree add 失败：' + String(added.stderr || added.stdout || '').trim().slice(0, 400) };
  }
  return { ok: true, path: target, relativePath: path.relative(root, target), branch, base, created: true };
}

/** 同一仓库串行创建工作树；否则并发批次可能同时通过 MAX_WORKTREES 检查而超过磁盘副本上限。 */
function createWorktree(projectRoot, options, helpers) {
  const key = normalizePath(projectRoot || '.');
  const previous = worktreeCreationQueues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  worktreeCreationQueues.set(key, queued);
  return previous
    .then(() => createWorktreeUnlocked(projectRoot, options, helpers))
    .finally(() => {
      release();
      if (worktreeCreationQueues.get(key) === queued) worktreeCreationQueues.delete(key);
    });
}

/** 收集工作树里未提交的改动（供主代理判断「要不要合并」） */
async function changedFiles(worktreePath, options) {
  const res = await runGit(worktreePath, ['status', '--porcelain'], options);
  if (!res.ok) return [];
  return res.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
}

/** 工作树里已提交但基线没有的提交数（合并前先看清「他到底做了什么」） */
async function commitCount(worktreePath, base, options) {
  const res = await runGit(worktreePath, ['rev-list', '--count', String(base || 'HEAD') + '..HEAD'], options);
  if (!res.ok) return 0;
  return Number(res.stdout.trim()) || 0;
}

async function pendingFingerprint(root, pending) {
  const hash = createHash('sha256');
  for (const line of pending.slice().sort()) {
    const raw = line.slice(3);
    // Quoted and rename paths need Git's -z parser; refuse instead of hashing the wrong file.
    if (!raw || raw.startsWith('"') || raw.includes(' -> ')) return null;
    const file = path.resolve(root, raw);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    hash.update(line + '\0');
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error && error.code === 'ENOENT') { hash.update('absent\0'); continue; }
      throw error;
    }
    if (stat.isSymbolicLink()) { hash.update('link\0' + fs.readlinkSync(file) + '\0'); continue; }
    if (!stat.isFile()) return null;
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Preview a managed branch before integrating it into the main checkout. */
async function inspectMerge(projectRoot, name, options) {
  const root = path.resolve(projectRoot || '.');
  const slug = slugify(name);
  const managed = await managedWorktrees(root, options);
  const source = managed.find((row) => path.basename(normalizePath(row.path)) === slug);
  if (!source || !source.branch || !source.branch.startsWith('codenode/')) {
    return { ok: false, error: 'NOT_MANAGED', message: '只能合并受管工作树的 codenode/ 分支：' + slug };
  }
  const current = await currentBranch(root, options);
  if (!current || current === source.branch) {
    return { ok: false, error: 'NO_TARGET', message: '主工作树必须位于另一个有效分支，才能合并 ' + source.branch };
  }
  const targetStatus = await runGit(root, ['status', '--porcelain', '--untracked-files=all'], options);
  if (!targetStatus.ok) return { ok: false, error: 'GIT_FAILED', message: '无法检查主工作树状态' };
  if (targetStatus.stdout.length >= MAX_OUTPUT_CHARS) return { ok: false, error: 'REVIEW_LIMIT', message: '主工作树状态输出过长，无法可靠预检' };
  const targetChanges = targetStatus.stdout.split(/\r?\n/).filter((line) => line && !/^\?\? \.codenode\/worktrees\//.test(line));
  if (targetChanges.length) {
    return { ok: false, error: 'TARGET_DIRTY', message: '主工作树有未提交改动；请先保存或提交后再合并', changed: targetChanges };
  }
  const mergeHead = await runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], options);
  if (mergeHead.ok) return { ok: false, error: 'MERGE_IN_PROGRESS', message: '主工作树已有未完成的合并，先处理该合并' };
  const targetHead = await runGit(root, ['rev-parse', 'HEAD'], options);
  const sourceHead = await runGit(source.path, ['rev-parse', 'HEAD'], options);
  if (!targetHead.ok || !sourceHead.ok) return { ok: false, error: 'GIT_FAILED', message: '无法读取合并前的提交版本' };
  const sourceStatus = await runGit(source.path, ['status', '--porcelain', '--untracked-files=all'], options);
  if (!sourceStatus.ok) return { ok: false, error: 'GIT_FAILED', message: '无法检查隔离工作树状态' };
  if (sourceStatus.stdout.length >= MAX_OUTPUT_CHARS) return { ok: false, error: 'REVIEW_LIMIT', message: '隔离工作树状态输出过长，无法可靠预检' };
  const committed = await runGit(root, ['diff', '--name-only', 'HEAD...' + source.branch], options);
  if (!committed.ok) return { ok: false, error: 'GIT_FAILED', message: '无法列出分支改动；可能缺少共同基线' };
  if (committed.stdout.length >= MAX_OUTPUT_CHARS) return { ok: false, error: 'REVIEW_LIMIT', message: '分支文件清单过长，无法可靠预检' };
  const pending = sourceStatus.stdout.split(/\r?\n/).filter(Boolean);
  const pendingDigest = await pendingFingerprint(source.path, pending);
  if (!pendingDigest) return { ok: false, error: 'UNSUPPORTED_PATH', message: '待合并改动含复杂路径或目录，无法可靠核对内容；请先在隔离分支手动提交' };
  const files = [...new Set(committed.stdout.split(/\r?\n/).filter(Boolean).concat(pending.map((line) => line.slice(3))))].sort();
  const ahead = await runGit(root, ['rev-list', '--count', 'HEAD..' + source.branch], options);
  if (!ahead.ok) return { ok: false, error: 'GIT_FAILED', message: '无法计算待合并提交数' };
  return {
    ok: true, name: slug, path: source.path, branch: source.branch, targetBranch: current,
    targetHead: targetHead.stdout.trim(), sourceHead: sourceHead.stdout.trim(),
    pending, pendingDigest, files, commits: Number(ahead.stdout.trim()) || 0,
  };
}

/** Integrate a reviewed worktree. A failed merge is aborted; the source branch is retained. */
async function mergeWorktree(projectRoot, args, options) {
  const root = path.resolve(projectRoot || '.');
  const preview = await inspectMerge(root, args && args.name, options);
  if (!preview.ok) return preview;
  const files = preview.files || [];
  const pending = preview.pending || [];
  if (!args || preview.targetHead !== args.expectedTargetHead || preview.sourceHead !== args.expectedSourceHead ||
      preview.targetBranch !== args.expectedTargetBranch || preview.pendingDigest !== args.expectedPendingDigest) {
    return { ok: false, error: 'STALE_PREVIEW', message: '预览后分支版本已变化；请重新 inspect_merge 后再试' };
  }
  if (!files.length && preview.commits === 0) {
    return { ok: false, error: 'NO_CHANGES', message: '隔离工作树没有可合并改动' };
  }
  if (pending.length) {
    const message = String(args.commitMessage || '').trim();
    if (!message || message.length > 200) {
      return { ok: false, error: 'COMMIT_MESSAGE_REQUIRED', message: '隔离工作树有未提交改动，合并前需提供不超过 200 字的 commitMessage' };
    }
    const added = await runGit(preview.path, ['add', '--all'], options);
    if (!added.ok) return { ok: false, error: 'GIT_FAILED', message: '隔离工作树暂存失败；主工作树未改变' };
    const committed = await runGit(preview.path, ['commit', '-m', message], options);
    if (!committed.ok) return { ok: false, error: 'COMMIT_FAILED', message: '隔离工作树提交失败；主工作树未改变，暂存内容保留：' + committed.stdout.slice(0, 400) };
  }
  const targetNow = await runGit(root, ['rev-parse', 'HEAD'], options);
  const targetDirty = await runGit(root, ['status', '--porcelain', '--untracked-files=all'], options);
  const unexpected = targetDirty.stdout.split(/\r?\n/).filter((line) => line && !/^\?\? \.codenode\/worktrees\//.test(line));
  if (!targetNow.ok || targetNow.stdout.trim() !== preview.targetHead || !targetDirty.ok || unexpected.length) {
    return { ok: false, error: 'STALE_TARGET', message: '提交隔离改动期间主工作树发生变化；未执行合并，隔离分支保留' };
  }
  const merged = await runGit(root, ['merge', '--no-ff', '--no-edit', preview.branch], options);
  if (!merged.ok) {
    const conflicts = await runGit(root, ['diff', '--name-only', '--diff-filter=U'], options);
    const mergeHead = await runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], options);
    const aborted = mergeHead.ok ? await runGit(root, ['merge', '--abort'], options) : null;
    return {
      ok: false, error: conflicts.stdout.trim() ? 'MERGE_CONFLICT' : 'MERGE_FAILED',
      message: aborted && !aborted.ok
        ? '合并失败且自动回退失败，请检查主工作树状态；隔离分支仍保留'
        : '合并失败，主工作树已回退；隔离分支保留供解决冲突后重试',
      conflicts: conflicts.stdout.split(/\r?\n/).filter(Boolean), rollbackOk: !aborted || aborted.ok,
    };
  }
  const head = await runGit(root, ['rev-parse', 'HEAD'], options);
  return { ok: true, branch: preview.branch, targetBranch: preview.targetBranch, head: head.stdout.trim(), files, sourcePath: preview.path };
}

/**
 * 移除工作树（默认拒绝强删有未提交改动的工作树 —— 那是别人的代码）
 * @param {string} projectRoot
 * @param {{name?: string, path?: string, force?: boolean}} options
 * @param {{context?: any, policy?: any}} [helpers] 隔离层所需的上下文/策略
 */
async function removeWorktree(projectRoot, options, helpers) {
  const opts = /** @type {any} */ (Object.assign({}, options || {}, helpers || {}));
  const root = path.resolve(projectRoot || '.');
  const wanted = String(opts.path || opts.name || '').trim();
  if (!wanted) return { ok: false, error: 'MISSING_TARGET', message: '需要 name 或 path' };
  const managed = await managedWorktrees(root, opts);
  const wantedPath = path.isAbsolute(wanted) ? path.resolve(wanted) : path.join(worktreesRoot(root), slugify(wanted));
  const hit =
    managed.find((w) => normalizePath(w.path) === normalizePath(wantedPath)) ||
    managed.find((w) => path.basename(w.path) === slugify(wanted));
  if (!hit) {
    return {
      ok: false,
      error: 'NOT_MANAGED',
      message: '只能移除受管目录下的工作树（.codenode/worktrees/…）：' + wanted,
      managed: managed.map((w) => path.basename(w.path)),
    };
  }
  const dirty = await changedFiles(hit.path, opts);
  if (dirty.length && opts.force !== true) {
    return { ok: false, error: 'DIRTY', message: '该工作树有 ' + dirty.length + ' 个未提交改动：先合并或备份，确要丢弃请 force:true', changed: dirty };
  }
  const removed = await runGit(root, ['worktree', 'remove', ...(opts.force === true ? ['--force'] : []), hit.path], opts);
  if (!removed.ok) {
    return { ok: false, error: 'GIT_FAILED', message: 'git worktree remove 失败：' + String(removed.stderr || removed.stdout || '').trim().slice(0, 400) };
  }
  await runGit(root, ['worktree', 'prune'], opts);
  return { ok: true, path: hit.path, branch: hit.branch, discardedChanges: dirty.length };
}

module.exports = {
  MAX_WORKTREES,
  GIT_TIMEOUT_MS,
  normalizePath,
  isManagedPath,
  worktreesRoot,
  slugify,
  runGit,
  isGitRepo,
  currentBranch,
  listWorktrees,
  managedWorktrees,
  createWorktree,
  inspectMerge,
  mergeWorktree,
  removeWorktree,
  changedFiles,
  commitCount,
};
