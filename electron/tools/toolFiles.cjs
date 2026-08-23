/**
 * ToolFiles：文件搜索类工具共用的目录忽略与二进制检测（复刻原版 ToolFiles）
 */
'use strict';

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

function shouldSkipDir(dirName) {
  return IGNORED_DIRS.has(dirName);
}

function isBinaryFileName(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXTS.has(name.slice(dot + 1).toLowerCase());
}

function isBinaryPath(filePath) {
  return isBinaryFileName(require('path').basename(filePath));
}

/** 路径字符串 → 若包含忽略目录返回 true */
function hasIgnoredDir(relative) {
  return relative.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));
}

module.exports = { IGNORED_DIRS, BINARY_EXTS, shouldSkipDir, isBinaryFileName, isBinaryPath, hasIgnoredDir };
