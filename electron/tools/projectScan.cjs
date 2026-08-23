/**
 * ProjectScan：项目全量扫描（源码 + 资产），跳过构建/缓存目录。
 * 返回文件清单（相对路径/名称/语言/扩展/行数/大小）与顶层目录树。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { shouldSkipDir, isBinaryFileName, IGNORED_DIRS } = require('./toolFiles.cjs');
const { detectLanguage } = require('./impl/shared.cjs');

const MAX_FILES = 20000;

function walk(root, dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of entries) {
    if (out.files.length >= MAX_FILES) return;
    const abs = path.join(dir, it.name);
    const childRel = rel ? rel + '/' + it.name : it.name;
    if (it.isDirectory()) {
      if (shouldSkipDir(it.name)) continue;
      walk(root, abs, childRel, out);
    } else if (it.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {}
      out.files.push({ relPath: childRel, absPath: abs, size });
    }
  }
}

/**
 * 扫描项目。
 * @returns {{ files: Array, sourceFiles: Array, assetFiles: Array }}
 *  sourceFiles: 文本/源码（非二进制）；assetFiles: 二进制资产。
 */
function scan(root) {
  const out = { files: [] };
  walk(root, root, '', out);
  out.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const sourceFiles = [];
  const assetFiles = [];
  for (const f of out.files) {
    const meta = fileMeta(root, f);
    if (meta.binary) assetFiles.push(meta);
    else sourceFiles.push(meta);
  }
  return { files: out.files, sourceFiles, assetFiles };
}

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

/** 语言统计：{ lang: count } */
function languageSummary(files) {
  const counts = {};
  for (const f of files) {
    if (f.binary) continue;
    counts[f.language] = (counts[f.language] || 0) + 1;
  }
  return counts;
}

/** 项目工程信息：构建系统/模块/入口候选/语言概览。 */
function detectProjectInfo(root) {
  const files = scan(root).files;
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

  const languages = languageSummary(files);
  return { buildSystem, mainCandidates, modules, jdks, languages, fileCount: files.length };
}

module.exports = { scan, fileMeta, languageSummary, detectProjectInfo, IGNORED_DIRS };
