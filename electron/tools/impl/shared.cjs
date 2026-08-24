/**
 * 文件类工具共享辅助：路径安全解析、语言检测、文本读取。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { isBinaryFileName, shouldSkipDir } = require('../toolFiles.cjs');

/** 解析项目内相对路径；越界返回 null。 */
function resolveInRoot(root, relative) {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, relative);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return null;
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
  if (!relative) return null;

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

/** 常见编程语言检测（按扩展名 + 文件名）。 */
function detectLanguage(filename) {
  const name = path.basename(filename);
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
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

/** 读取文本文件（UTF-8），最多 maxBytes；二进制返回 null。 */
function readTextFile(filePath, maxBytes) {
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
  // 简易二进制检测：含 NUL 字节判定为二进制
  if (buf.includes(0)) {
    return { ok: false, error: '二进制文件不能用 read_file 读取' };
  }
  const text = buf.toString('utf-8');
  if (text.includes('\uFFFD')) {
    return { ok: false, error: '非 UTF-8 文本文件，无法直接读取' };
  }
  return { ok: true, text };
}

/** glob 模式 → RegExp（支持 ** / * / ? / {...}，路径统一 / 分隔）。 */
function globToRegExp(glob) {
  let re = '';
  let i = 0;
  const pattern = glob;
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

module.exports = { resolveInRoot, resolveFileFuzzy, normalizeQuotes, detectLanguage, readTextFile, globToRegExp };
