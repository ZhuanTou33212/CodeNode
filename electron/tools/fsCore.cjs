/**
 * fsCore.cjs —— 文件遍历 / 扫描的**唯一实现来源**（纯 fs/path，零 Electron、零工具层依赖）
 *
 * 为什么要单独一层：这些遍历要从**主线程**搬到 **worker 线程**（P7 收口 —— 原实现只有
 * 「循环之间」的取消检查点，单次同步 fs 调用（读 2MB 文件算行数、裸读大目录）既不可中断，
 * 也会把主线程（Electron 主进程）整个卡住）。若 worker 里再抄一份遍历实现，两份逻辑必然漂移，
 * 所以实现只此一份：
 *   - `fsWorker.cjs`（worker 入口）require 它；
 *   - 主线程的**降级路径**与既有调用点也 require 它 —— `toolFiles.cjs` / `impl/shared.cjs` /
 *     `projectScan.cjs` 都改成从这里 re-export（对外 API 不变，调用方零改动）。
 *
 * ⚠️ 本文件必须保持**自包含**：只 require 内置模块（fs / path）。worker 相关文件在打包时被
 * `asarUnpack` 到真实文件系统，相对 require 只能解析 unpacked 目录里的兄弟文件 —— 多引一个
 * asar 内的模块就会在**打包版**里 `MODULE_NOT_FOUND`，而开发模式与 CI 都不会报错。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 扫描文件数硬上限（防止超大目录把结果撑爆） */
const MAX_SCAN_FILES = 20000;
/** 进度上报间隔（每处理多少个条目回调一次）—— 太密会淹没消息通道，太疏则取消后的 partial 不准 */
const PROGRESS_EVERY = 200;

// ---------------------------------------------------------------------------
// 目录忽略 / 二进制判定（原 toolFiles.cjs）
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  'target', 'build', '.git', '.idea', 'node_modules', 'dist', 'out', '.gradle', 'cache',
  '.vscode', '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'coverage', 'logs',
]);

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds', 'psd', 'ico', 'icns',
  'jar', 'class', 'war', 'zip', 'gz', '7z', 'rar', 'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'lib',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'avi', 'mkv', 'mov', 'webm', 'ttf', 'otf', 'woff', 'woff2', 'eot',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'db', 'sqlite', 'bin', 'dat',
]);

/**
 * 该目录名是否应跳过。
 * @param {string} dirName
 */
function shouldSkipDir(dirName) {
  return IGNORED_DIRS.has(dirName);
}

/**
 * 按文件名后缀判断是否二进制。
 * @param {string} name
 */
function isBinaryFileName(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** @param {string} filePath */
function isBinaryPath(filePath) {
  return isBinaryFileName(path.basename(filePath));
}

/**
 * 相对路径里是否含忽略目录。
 * @param {string} relative
 */
function hasIgnoredDir(relative) {
  return String(relative || '').split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));
}

// ---------------------------------------------------------------------------
// 敏感文件判定（原 impl/shared.cjs）—— search_files 在 worker 里也要用它
// ---------------------------------------------------------------------------

const SENSITIVE_FILE_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', 'agent.properties',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SENSITIVE_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.der']);

/**
 * 防止 read_file / search_files 把凭据原文发送给模型；RAG 索引也使用同等规则。
 * @param {string} relative
 */
function isSensitivePath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').toLowerCase();
  const name = path.posix.basename(normalized);
  const ext = path.posix.extname(name);
  return (
    SENSITIVE_FILE_NAMES.has(name) ||
    name.startsWith('.env.') ||
    SENSITIVE_FILE_EXTENSIONS.has(ext) ||
    /(^|[._-])(credentials?|secrets?|private[-_]?key)([._-]|$)/i.test(name)
  );
}

// ---------------------------------------------------------------------------
// glob / 语言检测（原 impl/shared.cjs）
// ---------------------------------------------------------------------------

/**
 * glob 模式 → RegExp（支持 ** / * / ? / {...}，路径统一 / 分隔）。
 * @param {string} glob
 */
function globToRegExp(glob) {
  let re = '';
  let i = 0;
  const pattern = String(glob || '');
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** 匹配跨目录
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const options = pattern.slice(i + 1, end).split(',').map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += '(?:' + options.join('|') + ')';
        i = end + 1;
      } else {
        re += '\\{';
        i++;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * 常见编程语言检测（按扩展名 + 文件名）。
 * @param {string} filename
 */
function detectLanguage(filename) {
  const name = path.basename(String(filename || ''));
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  /** @type {Record<string, string>} */
  const map = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', java: 'java', kt: 'kotlin', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
    hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', scala: 'scala', dart: 'dart',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', vue: 'vue', svelte: 'svelte',
    json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', md: 'markdown', markdown: 'markdown',
    txt: 'text', sh: 'shell', bash: 'shell', bat: 'batch', cmd: 'batch', ps1: 'powershell',
    sql: 'sql', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', gradle: 'groovy', dockerfile: 'dockerfile',
  };
  if (map[ext]) return map[ext];
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  if (lower === 'package.json' || lower === 'package-lock.json') return 'json';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 遍历（find_files / search_files 共用）
// ---------------------------------------------------------------------------

/**
 * 深度优先遍历文件；只对**文件**回调（目录不下发）。
 * 顺序与 `fs.readdirSync` 一致 —— 与旧的工具内实现逐条对齐，保证结果可复现。
 * @param {string} root 项目根（用于算相对路径、判定是否跳过同名根目录）
 * @param {string} dir 当前目录
 * @param {RegExp|null} fileRegex 文件名过滤（对相对路径做 test）；null = 全部
 * @param {(abs: string, relative: string) => void} onFile
 * @param {() => boolean} [shouldStop] 返回 true 立即结束遍历（同步降级路径用；worker 路径靠 terminate）
 */
function walkEachFile(root, dir, fileRegex, onFile, shouldStop) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of entries) {
    if (shouldStop && shouldStop()) return;
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (it.name !== path.basename(root) && shouldSkipDir(it.name)) continue;
      walkEachFile(root, abs, fileRegex, onFile, shouldStop);
    } else if (it.isFile()) {
      const relative = path.relative(root, abs).replace(/\\/g, '/');
      if (fileRegex && !fileRegex.test(relative)) continue;
      if (onFile) onFile(abs, relative);
    }
  }
}

// ---------------------------------------------------------------------------
// 扫描（scan_project）
// ---------------------------------------------------------------------------

/**
 * 递归收集文件清单。
 * @param {string} root
 * @param {string} dir
 * @param {string} rel
 * @param {{ files: Array, stopped: boolean }} out
 * @param {() => boolean|null} shouldStop
 * @param {((count: number) => void)|null} onProgress
 */
function walk(root, dir, rel, out, shouldStop, onProgress) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of entries) {
    if (out.files.length >= MAX_SCAN_FILES) return;
    if (shouldStop && shouldStop()) {
      out.stopped = true;
      return;
    }
    const abs = path.join(dir, it.name);
    const childRel = rel ? rel + '/' + it.name : it.name;
    if (it.isDirectory()) {
      if (shouldSkipDir(it.name)) continue;
      walk(root, abs, childRel, out, shouldStop, onProgress);
    } else if (it.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {}
      out.files.push({ relPath: childRel, absPath: abs, size });
      if (onProgress && out.files.length % PROGRESS_EVERY === 0) onProgress(out.files.length);
    }
  }
}

/**
 * 单个文件的元信息（语言 / 大小 / 行数 / 是否二进制）。
 * 注意：这里会**读取整个文件**算行数 —— 正是「单次同步 fs 调用不可中断」的典型，
 * 也是这些任务必须跑在 worker 里的原因。
 * @param {string} root
 * @param {{ relPath: string, absPath: string, size: number }} f
 */
function fileMeta(root, f) {
  const name = path.basename(f.relPath);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const binary = isBinaryFileName(name);
  let lineCount = 0;
  if (!binary) {
    try {
      const buf = fs.readFileSync(f.absPath);
      if (buf.includes(0)) {
        // 仍算二进制（NUL）
        return { relativePath: f.relPath, name, language: 'binary', ext, binary: true, size: f.size, lineCount: 0 };
      }
      const text = buf.toString('utf-8');
      lineCount = text.split('\n').length - 1;
      if (text.includes('\uFFFD')) {
        return { relativePath: f.relPath, name, language: 'unknown', ext, binary: false, size: f.size, lineCount: 0 };
      }
    } catch {}
  }
  return {
    relativePath: f.relPath,
    name,
    language: binary ? 'binary' : detectLanguage(name),
    ext,
    binary,
    size: f.size,
    lineCount,
  };
}

/**
 * 扫描项目。
 * @param {string} root
 * @param {{ shouldStop?: () => boolean, onProgress?: (count: number) => void }} [options]
 *   shouldStop 返回 true 时**提前结束**并把 `stopped` 置真 —— 调用方据此如实回报「结果不完整」。
 * @returns {{ files: Array, sourceFiles: Array, assetFiles: Array, stopped: boolean, cancelled: boolean, scanned: number }}
 *   `stopped` 与 `cancelled` 同义（后者是给任务层用的统一字段名）：都只由 `shouldStop` 触发，
 *   `MAX_SCAN_FILES` 截断**不算**取消。
 */
function scan(root, options) {
  const opts = options || {};
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  /** @type {{ files: Array, stopped: boolean }} */
  const out = { files: [], stopped: false };
  walk(root, root, '', out, shouldStop, onProgress);
  out.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const sourceFiles = [];
  const assetFiles = [];
  for (let i = 0; i < out.files.length; i++) {
    // 逐文件分类阶段同样可取消（大项目里这一步比遍历本身还慢：每个源文件都要读一遍算行数）
    if (shouldStop && shouldStop()) {
      out.stopped = true;
      break;
    }
    const meta = fileMeta(root, out.files[i]);
    if (meta.binary) assetFiles.push(meta);
    else sourceFiles.push(meta);
    if (onProgress && i > 0 && i % PROGRESS_EVERY === 0) onProgress(i);
  }
  return { files: out.files, sourceFiles, assetFiles, stopped: out.stopped, cancelled: out.stopped, scanned: out.files.length };
}

/**
 * 任务 1：扫描项目。
 * @param {any} payload
 */
function scanProjectTask(payload) {
  const p = payload || {};
  const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null;
  const shouldStop = typeof p.shouldStop === 'function' ? p.shouldStop : null;
  const result = scan(String(p.root || ''), { shouldStop, onProgress });
  // 统一取消标志：scan 的 `stopped` 只由 shouldStop 触发（MAX_SCAN_FILES 截断不设它），
  // 对外暴露成 cancelled —— 调用方（工具层）据此判定「结果不完整」，不该自己猜字段含义。
  return Object.assign({}, result, { cancelled: result.cancelled === true });
}

/**
 * 任务 2：按 glob 查找文件。
 * @param {any} payload
 */
function findFilesTask(payload) {
  const p = payload || {};
  const root = String(p.root || '');
  const regex = globToRegExp(String(p.pattern || ''));
  const limit = Math.max(1, Math.floor(Number(p.limit) || 1));
  const shouldStop = typeof p.shouldStop === 'function' ? p.shouldStop : null;
  const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null;
  /** @type {string[]} */
  const found = [];
  let stopped = false;
  let cancelled = false;
  walkEachFile(
    root,
    root,
    regex,
    (_abs, relative) => {
      if (found.length < limit) found.push(relative);
      if (onProgress && found.length % PROGRESS_EVERY === 0) onProgress(found.length);
    },
    () => {
      if (found.length >= limit) {
        stopped = true; // 达到上限：与旧行为一致（提前结束，**不算被取消**）
        return true;
      }
      if (shouldStop && shouldStop()) {
        stopped = true;
        cancelled = true;
        return true;
      }
      return false;
    },
  );
  return { files: found, stopped, cancelled, scanned: found.length };
}

/**
 * 任务 3：按正则搜索文件内容。
 * @param {any} payload
 */
function searchFilesTask(payload) {
  const p = payload || {};
  const root = String(p.root || '');
  const start = String(p.start || root);
  const regex = new RegExp(String(p.pattern || ''), p.caseSensitive === true ? '' : 'i');
  const fileRegex = p.filePattern ? globToRegExp(String(p.filePattern)) : null;
  const maxCollect = Math.max(1, Math.floor(Number(p.maxCollect) || 1));
  const maxFileBytes = Math.max(1024, Math.floor(Number(p.maxFileBytes) || 2 * 1024 * 1024));
  const shouldStop = typeof p.shouldStop === 'function' ? p.shouldStop : null;
  const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null;
  /** @type {string[]} */
  const matches = [];
  let scanned = 0;
  let stopped = false;
  let cancelled = false;
  walkEachFile(
    start,
    start,
    fileRegex,
    (abs, relative) => {
      if (matches.length >= maxCollect) return;
      if (isSensitivePath(relative)) return;
      if (isBinaryFileName(path.basename(abs))) return;
      let size;
      try {
        size = fs.statSync(abs).size;
      } catch {
        return;
      }
      scanned += 1;
      if (onProgress && scanned % PROGRESS_EVERY === 0) onProgress(scanned);
      if (size > maxFileBytes) return;
      let lines;
      try {
        const buf = fs.readFileSync(abs);
        if (buf.includes(0)) return;
        lines = buf.toString('utf-8').split('\n');
      } catch {
        return;
      }
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxCollect) return;
        if (regex.test(lines[i])) {
          matches.push(relative + ':' + (i + 1) + ': ' + lines[i].trim());
        }
      }
    },
    () => {
      if (matches.length >= maxCollect) {
        stopped = true; // 达到上限（不算被取消）
        return true;
      }
      if (shouldStop && shouldStop()) {
        stopped = true;
        cancelled = true;
        return true;
      }
      return false;
    },
  );
  return { matches, stopped, cancelled, scanned };
}

// ---------------------------------------------------------------------------
// 文本读取 / 结构摘要 / 工程信息（analyze_project 与 project_info 的实现）
// ---------------------------------------------------------------------------

/**
 * 读取文本文件（与 read_file 同规则：大小上限、二进制、非 UTF-8 一律拒绝）。
 * 从 `impl/shared.cjs` 搬来 —— worker 里的 analyze_project 任务要用它，而 fsCore 必须自包含。
 * @param {string} filePath
 * @param {number} [maxBytes]
 */
function readTextFileSafe(filePath, maxBytes) {
  const MAX = maxBytes || 2 * 1024 * 1024;
  const stat = fs.statSync(filePath);
  if (stat.size > MAX) return { ok: false, error: '文件超过 ' + MAX + ' 字节上限，请用 search_files 或拆分后读取' };
  if (isBinaryFileName(path.basename(filePath))) {
    return { ok: false, error: '二进制文件不能用 read_file 读取' };
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: '读取失败：' + ((e && e.message) || e) };
  }
  if (buf.includes(0)) return { ok: false, error: '二进制文件不能用 read_file 读取' };
  const text = buf.toString('utf-8');
  if (text.includes('\uFFFD')) return { ok: false, error: '非 UTF-8 文本文件，无法直接读取' };
  return { ok: true, text };
}

/**
 * 逐文件结构摘要（import / 类 / 函数 / 变量），只看前 300 行。
 * 从 `impl/analyzeProjectTool.cjs` 搬来（同一份逻辑要跑在 worker 里）。
 * @param {string} root
 * @param {{ relativePath: string, language: string }} meta
 */
function summarizeFile(root, meta) {
  const full = path.join(root, meta.relativePath);
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    const read = readTextFileSafe(full);
    if (!read.ok) return null;
    const lines = read.text.split('\n');
    const imports = [];
    const classes = [];
    const functions = [];
    const variables = [];
    for (const line of lines.slice(0, 300)) {
      const t = line.trim();
      if (!t) continue;
      if (/^(import|from|using|require\s*\(|include\s+|#include\s*<)/.test(t)) {
        imports.push(t.length > 120 ? t.slice(0, 120) : t);
        continue;
      }
      const cl = t.match(/\b(class|interface|trait|struct|type)\s+([A-Za-z_$][\w$]*)/);
      if (cl) {
        classes.push(cl[2]);
        continue;
      }
      if (/\b(def|func|function|fun)\s+/.test(t) || /^\s*(public|private|protected)\s+\w+\s+\w+\s*\(/.test(t)) {
        functions.push(t.length > 120 ? t.slice(0, 120) : t);
        continue;
      }
      const vr = t.match(/^\s*(let|var|const|val)\s+([A-Za-z_$][\w$]*)/);
      if (vr) variables.push(vr[1]);
    }
    return {
      path: meta.relativePath,
      language: meta.language,
      imports: imports.slice(0, 40),
      classes: [...new Set(classes)],
      functions: functions.slice(0, 40),
      variables: [...new Set(variables)].slice(0, 60),
      lineCount: lines.length,
    };
  } catch {
    return null;
  }
}

/** 语言统计：{ lang: count } */
function languageSummary(files) {
  const counts = {};
  for (const f of files) {
    if (f.binary) continue;
    counts[f.language] = (counts[f.language] || 0) + 1;
  }
  return counts;
}

/**
 * 从扫描结果推导工程信息（构建系统 / 入口候选 / 模块 / 语言概览）。
 * **纯函数：不碰 fs** —— worker 与主线程共用同一份推导，避免两处漂移。
 *
 * ⚠️ 语言统计必须用 `scanned.sourceFiles`（fileMeta 的产物，带 `language` / `binary`），
 * **不能**用 `scanned.files`（只有 `relPath` / `absPath` / `size`）。旧实现传的是后者，
 * 于是 `languageSummary` 读到的 language 是 undefined、`f.binary` 也是 undefined，
 * `languages` 恒为 `{"undefined": <文件数>}` —— 本轮修掉，并有用例锁住。
 * @param {string} root
 * @param {{ files?: Array<any>, sourceFiles?: Array<any> }} scanned scan() 的完整结果
 */
function buildProjectInfo(root, scanned) {
  const files = (scanned && scanned.files) || [];
  const sourceFiles = (scanned && scanned.sourceFiles) || files;
  const set = new Set(files.map((f) => f.relPath));
  let buildSystem = 'plain';
  if (set.has('package.json')) buildSystem = 'npm';
  else if (set.has('pom.xml')) buildSystem = 'maven';
  else if (set.has('build.gradle') || set.has('build.gradle.kts') || set.has('settings.gradle')) buildSystem = 'gradle';
  else if (set.has('requirements.txt') || set.has('pyproject.toml')) buildSystem = 'python';
  else if (set.has('go.mod')) buildSystem = 'go';
  else if (set.has('Cargo.toml')) buildSystem = 'cargo';

  const mainCandidates = [];
  for (const f of files) {
    const rel = f.relPath;
    if (/^src\/(main|index)\.[jt]sx?$/.test(rel)) mainCandidates.push(rel);
    else if (rel === 'main.py' || /^src\/main\.py$/.test(rel)) mainCandidates.push(rel);
    else if (rel === 'Main.java' || /^src\/main\/java\/.*\/Main\.java$/.test(rel)) mainCandidates.push(rel);
    else if (rel === 'index.ts' || rel === 'index.js') mainCandidates.push(rel);
    else if (rel === 'main.go') mainCandidates.push(rel);
    else if (rel === 'main.rs') mainCandidates.push(rel);
  }

  const jdks = [];
  if (buildSystem === 'maven' || buildSystem === 'gradle') {
    try {
      const javaHome = process.env.JAVA_HOME;
      if (javaHome) jdks.push(path.basename(javaHome));
    } catch {}
  }

  const srcRoots = ['src', 'src/main', 'src/main/java', 'src/main/kotlin', 'src/main/resources', 'lib', 'packages'];
  const modules = srcRoots.filter((s) => set.has(s) || files.some((f) => f.relPath.startsWith(s + '/')));

  return { buildSystem, mainCandidates, modules, jdks, languages: languageSummary(sourceFiles), fileCount: files.length };
}

/**
 * 任务 4：工程信息识别。
 * 它内部会**扫全项目**（每个源文件都要读一遍算行数）—— 与 scan_project 同属「必须跑在 worker 里」的重活。
 * @param {any} payload
 */
function detectProjectInfoTask(payload) {
  const p = payload || {};
  const root = String(p.root || '');
  const shouldStop = typeof p.shouldStop === 'function' ? p.shouldStop : null;
  const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null;
  const scanned = scan(root, { shouldStop, onProgress });
  const info = buildProjectInfo(root, scanned);
  /** @type {Record<string, any>} */
  const out = Object.assign({}, info, { cancelled: scanned.cancelled === true, scanned: scanned.scanned });
  // 只有调用方真的要文件清单时才回传（结构化克隆大数组不便宜）
  if (p.includeFiles) {
    out.files = scanned.files;
    out.sourceFiles = scanned.sourceFiles;
    out.assetFiles = scanned.assetFiles;
  }
  return out;
}

/**
 * 任务 5：analyze_project —— **一次扫描**同时产出工程信息、文件清单与逐文件结构摘要。
 * 旧实现是 `detectProjectInfo(root)` + `scan(root)`（扫两遍）再逐文件读；这里合并成一次扫描。
 * @param {any} payload
 */
function analyzeProjectTask(payload) {
  const p = payload || {};
  const root = String(p.root || '');
  const analyzeFiles = p.analyzeFiles !== false;
  const limit = Number.isFinite(Number(p.limit)) ? Math.max(1, Math.min(1000, Math.floor(Number(p.limit)))) : 1000;
  const shouldStop = typeof p.shouldStop === 'function' ? p.shouldStop : null;
  const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null;
  const scanned = scan(root, { shouldStop, onProgress });
  const info = buildProjectInfo(root, scanned);
  /** @type {Array<any>} */
  const fileAnalysis = [];
  if (analyzeFiles && !scanned.cancelled) {
    for (const f of scanned.sourceFiles) {
      if (fileAnalysis.length >= limit) break;
      if (shouldStop && shouldStop()) break;
      const entry = summarizeFile(root, f);
      if (entry) fileAnalysis.push(entry);
    }
  }
  return {
    buildSystem: info.buildSystem,
    mainCandidates: info.mainCandidates,
    modules: info.modules,
    jdks: info.jdks,
    languageSummary: info.languages,
    fileCount: info.fileCount,
    sourceFileCount: scanned.sourceFiles.length,
    assetFileCount: scanned.assetFiles.length,
    files: scanned.sourceFiles.slice(0, limit).map((f) => ({
      relativePath: f.relativePath,
      name: f.name,
      language: f.language,
      ext: f.ext,
      lineCount: f.lineCount,
    })),
    fileAnalysis,
    cancelled: scanned.cancelled === true,
    scanned: scanned.scanned,
  };
}

/** worker 支持的任务名（runner 用它做白名单校验） */
const FS_TASKS = Object.freeze(['scanProject', 'findFiles', 'searchFiles', 'detectProjectInfo', 'analyzeProject']);

/**
 * 同步执行一个任务（降级路径：worker 不可用时由主线程直接跑，会阻塞事件循环）。
 * @param {string} task
 * @param {any} payload
 */
function runTaskSync(task, payload) {
  if (task === 'scanProject') return scanProjectTask(payload);
  if (task === 'findFiles') return findFilesTask(payload);
  if (task === 'searchFiles') return searchFilesTask(payload);
  if (task === 'detectProjectInfo') return detectProjectInfoTask(payload);
  if (task === 'analyzeProject') return analyzeProjectTask(payload);
  throw new Error('未知文件任务：' + task);
}

module.exports = {
  MAX_SCAN_FILES,
  PROGRESS_EVERY,
  IGNORED_DIRS,
  BINARY_EXTS,
  shouldSkipDir,
  isBinaryFileName,
  isBinaryPath,
  hasIgnoredDir,
  isSensitivePath,
  globToRegExp,
  detectLanguage,
  walk,
  scan,
  fileMeta,
  walkEachFile,
  scanProjectTask,
  findFilesTask,
  searchFilesTask,
  detectProjectInfoTask,
  analyzeProjectTask,
  readTextFileSafe,
  summarizeFile,
  buildProjectInfo,
  languageSummary,
  runTaskSync,
  FS_TASKS,
};
