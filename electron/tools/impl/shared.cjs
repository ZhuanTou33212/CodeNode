/**
 * 文件类工具共享辅助：路径安全解析、语言检测、文本读取。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { isBinaryFileName, shouldSkipDir } = require('../toolFiles.cjs');
// 敏感文件判定 / 语言检测 / glob 解析的唯一实现在 fsCore —— 同一份逻辑要跑在 worker 线程里，
// 这里只做 re-export，保持既有 import 路径不变。
const fsCore = require('../fsCore.cjs');
const { isSensitivePath, detectLanguage, globToRegExp, readTextFileSafe } = fsCore;


/** 解析项目内相对路径；越界返回 null。 */
function resolveInRoot(root, relative) {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, relative);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    let existing = full;
    while (!fs.existsSync(existing)) {
      // Dangling links must not be treated as ordinary missing paths.
      try { if (fs.lstatSync(existing).isSymbolicLink()) return null; } catch {}
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      existing = parent;
    }
    const real = fs.realpathSync(existing);
    const inside = path.relative(realRoot, real);
    if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) return null;
  } catch { return null; }
  return full;
}

/** 引号归一化：把中文全角引号 “ ” ‘ ’ 与 ASCII 引号视为等价（模型常把文件名里的全角引号写成半角导致路径找不到） */
function normalizeQuotes(s) {
  return String(s || '').toLowerCase().replace(/[\u201C\u201D\u2018\u2019"'`]/g, '"');
}

/**
 * 宽容解析文件路径：精确不存在时，按「引号等价」在当前目录及全项目内模糊匹配文件名。
 * @returns {string|null} 实际存在的绝对路径；无匹配返回 null
 */
function resolveFileFuzzy(root, relative) {
  const resolvedRoot = path.resolve(root);
  const full = resolveInRoot(root, relative);
  if (full && fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  if (!relative || !full) return null;

  const baseName = path.basename(String(relative).replace(/[\\/]+/g, '/'));
  const dirName = path.dirname(String(relative).replace(/[\\/]+/g, '/'));
  const wanted = normalizeQuotes(baseName);

  // 1) 先按归一化名字匹配同一目录
  const dirAbs = path.join(resolvedRoot, dirName === '.' ? '' : dirName);
  if (fs.existsSync(dirAbs)) {
    try {
      for (const it of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        if (it.isFile() && normalizeQuotes(it.name) === wanted) return path.join(dirAbs, it.name);
      }
    } catch {}
  }

  // 2) 全项目扫描（跳过构建/缓存目录，限制遍历量）
  let walked = 0;
  const MAX_WALK = 20000;
  const queue = [''];
  while (queue.length && walked < MAX_WALK) {
    const relDir = queue.shift();
    const absDir = path.join(resolvedRoot, relDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of entries) {
      if (walked >= MAX_WALK) break;
      walked++;
      const rel = relDir ? relDir + '/' + it.name : it.name;
      if (it.isDirectory()) {
        if (relDir !== '' && shouldSkipDir(it.name)) continue;
        queue.push(rel);
      } else if (it.isFile() && normalizeQuotes(it.name) === wanted) {
        return path.join(absDir, it.name);
      }
    }
  }
  return null;
}


/** 读取文本文件（UTF-8），最多 maxBytes；二进制返回 null。 */
// 实现在 fsCore（worker 里的 analyze_project 任务要用同一份；详见该文件头说明）。
const readTextFile = fsCore.readTextFileSafe;


/** 节点类型 → 主色（与前端 NODE_TEMPLATES / WorkflowNode 保持一致，按类型判定而非外观） */
const NODE_TYPE_ACCENT = {
  start: '#22c55e',
  end: '#ef4444',
  task: '#3b82f6',
  stage: '#8b5cf6',
  tool: '#f59e0b',
  file: '#f97316',
  scope: '#8b5cf6',
  object: '#06b6d4',
  vector: '#22d3ee',
};

/** 按类型取节点主色，未知类型回退默认蓝。 */
function accentForType(type) {
  return NODE_TYPE_ACCENT[String(type || '')] || '#3b82f6';
}

/**
 * 同步工具的取消检查点（P7）。
 *
 * 限制要说清楚：JS 单线程挡不住**单次**同步 fs 调用（一次 readFileSync 大文件、一次
 * `JSON.parse` 巨型字符串），真正的可中断需要把这些工具挪到 worker/子进程 —— 那部分仍未做。
 * 但对**遍历很多文件**这类循环有效：在每条目录项之间检查一次，用户点「停止」就能在
 * 扫描/查找/检索中途真的停下来，而不是等它把整个项目走完。
 *
 * 用法（不抛异常，让工具自己决定如何如实返回）：
 *   if (isCancelled(context)) return AgentToolResult.failure('CANCELLED', '扫描已取消（用户停止）');
 *
 * @param {any} context 底层 AgentToolContext 或 ExecutionContext（新面 cancel.isCancelled）
 * @returns {boolean}
 */
function isCancelled(context) {
  if (!context) return false;
  try {
    if (typeof context.cancelled === 'function' && context.cancelled() === true) return true;
    const cancel = context.cancel;
    if (cancel && typeof cancel.isCancelled === 'function' && cancel.isCancelled() === true) return true;
    if (typeof context.signal === 'function') {
      const signal = context.signal();
      if (signal && signal.aborted === true) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 内容哈希（`sha256:<hex>`）—— 与 `electron/subagentEnvelope.cjs` 的 `sha256Of` **同口径**
 * （`sha256:<hex of utf8 text>`），两边必须一致才能互相比对（用例里有交叉核对断言防漂移）。
 */
function sha256OfText(text) {
  return 'sha256:' + require('crypto').createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 文件内容哈希；文件不存在返回 null */
function sha256OfFile(absPath) {
  try {
    return sha256OfText(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 乐观并发校验（P3 的另一半）：「我要基于**这一版**内容去写」。
 * @param {string} absPath
 * @param {any} expected `'absent'`（要求文件不存在）或 `sha256:…`（可省前缀）
 * @returns {{ok: boolean, reason?: string, actual: string|null}}
 */
function checkExpectedHash(absPath, expected) {
  const want = String(expected == null ? '' : expected).trim().toLowerCase();
  if (!want) return { ok: true, actual: null };
  const exists = fs.existsSync(absPath);
  const actual = exists ? sha256OfFile(absPath) : null;
  if (want === 'absent' || want === 'absent()' || want === 'none') {
    return exists ? { ok: false, reason: '要求「文件不存在」，但它已经存在（可能是别人先建了）', actual } : { ok: true, actual };
  }
  const normalized = want.startsWith('sha256:') ? want : 'sha256:' + want;
  if (!exists) return { ok: false, reason: '要求基于某个版本写入，但文件不存在了', actual: null };
  return actual === normalized ? { ok: true, actual } : { ok: false, reason: '内容与读入时不一致（读入后被人改过）', actual };
}

module.exports = {
  sha256OfText,
  sha256OfFile,
  checkExpectedHash,
  resolveInRoot,
  resolveFileFuzzy,
  normalizeQuotes,
  detectLanguage,
  readTextFile,
  globToRegExp,
  isSensitivePath,
  isCancelled,
  NODE_TYPE_ACCENT,
  accentForType,
};
