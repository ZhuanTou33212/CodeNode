/**
 * ToolFiles：文件搜索类工具共用的目录忽略与二进制检测。
 *
 * 实现已迁到 `electron/tools/fsCore.cjs`（唯一来源）—— 同一份逻辑要同时跑在主线程与
 * **worker 线程**里，两份代码必然漂移。本文件只做 re-export，保持既有 import 路径不变。
 */
'use strict';

const fsCore = require('./fsCore.cjs');

module.exports = {
  IGNORED_DIRS: fsCore.IGNORED_DIRS,
  BINARY_EXTS: fsCore.BINARY_EXTS,
  shouldSkipDir: fsCore.shouldSkipDir,
  isBinaryFileName: fsCore.isBinaryFileName,
  isBinaryPath: fsCore.isBinaryPath,
  hasIgnoredDir: fsCore.hasIgnoredDir,
};
