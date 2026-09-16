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

// 实现（语言统计 / 工程信息推导）已迁到 fsCore —— 同一份逻辑要跑在 worker 线程里。
// 这里保留**同步** API 供降级路径与其他调用点使用；走 worker 时用 fsCore 的两个任务。
const { languageSummary, buildProjectInfo } = fsCore;

/** 项目工程信息：构建系统/模块/入口候选/语言概览（同步版：内部扫全项目）。 */
function detectProjectInfo(root) {
  return buildProjectInfo(root, scan(root));
}

module.exports = { scan, fileMeta, languageSummary, detectProjectInfo, IGNORED_DIRS };
