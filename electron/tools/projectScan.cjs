/**
 * ProjectScan：项目全量扫描（源码 + 资产），跳过构建/缓存目录。
 * 返回文件清单（相对路径/名称/语言/扩展/行数/大小）与顶层目录树。
 */
'use strict';

const path = require('path');
// 遍历 / 扫描的唯一实现在 fsCore —— 同一份逻辑要同时跑在主线程与 worker 线程里，
// 两份实现必然漂移；这里只做 re-export，保持既有 import 路径与导出名不变。
const fsCore = require('./fsCore.cjs');
const { scan, fileMeta } = fsCore;
const { IGNORED_DIRS } = require('./toolFiles.cjs');

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
