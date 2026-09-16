/**
 * analyze_project：工程识别 + 源文件清单 + 逐文件结构摘要（import/class/function/变量）。
 * 用户在要求「分析文档/分析项目」时调用，Agent 应基于返回的结构化结果进行后续制作。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
// 遍历 / 摘要逻辑都在 fsCore（worker 里跑同一份实现）；这里只需要 runner 与取消检查。
const fsRunner = require('../fsRunner.cjs');
const { isCancelled } = require('./shared.cjs');

function register(registry) {
  registry.register(
    'analyze_project',
    '调用本地工程的识别与分析模块分析项目：返回构建系统、模块、入口候选、语言概览、源文件清单与逐文件结构摘要' +
      '（import/类/函数/变量）。path 为项目根目录（缺省当前项目）；analyzeFiles=true（默认）时逐文件提取结构摘要；' +
      'limitFiles 限制最多分析的文件数（默认 200）。用户在要求「分析文档/分析项目」时调用，Agent 应基于本工具返回的结构化结果进行后续制作。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目根目录（可选，缺省当前项目）' },
        analyzeFiles: { type: 'boolean', description: '是否逐文件提取结构摘要，默认 true' },
        limitFiles: { type: 'integer', description: '最多分析的文件数，默认 200，上限 1000' },
      },
      required: [],
    },
    async (context, args) => {
      const rawPath = String(args.path || '').trim();
      const root = rawPath ? path.resolve(rawPath) : path.resolve(context.projectRoot());
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在: ' + root);
      const analyzeFiles = args.analyzeFiles !== false;
      const limit = typeof args.limitFiles === 'number' && Number.isFinite(args.limitFiles) ? Math.max(1, Math.min(1000, Math.floor(args.limitFiles))) : 1000;
      context.audit('analyze_project root=' + root);
      try {
        // P7 收口：扫描 + 逐文件读取 + 结构摘要**整体**放进 worker 线程 ——
        //   ① 一次扫描搞定（旧实现 detectProjectInfo 与 scan 各扫一遍，等于把全项目读两轮）；
        //   ② 主线程不再被「读全项目算行数 + 逐文件摘要」冻住，取消也能真的 terminate。
        const outcome = await fsRunner.runFsTask(
          'analyzeProject',
          { root, analyzeFiles, limit, shouldStop: () => isCancelled(context) },
          { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
        );
        if (outcome.cancelled || outcome.timedOut) {
          return AgentToolResult.failure('CANCELLED', '项目分析已取消（用户停止），结果不完整。', { cancelled: true, root });
        }
        if (outcome.mode === 'sync-fallback') {
          context.audit('analyze_project worker 不可用，已退回主线程同步执行：' + outcome.fallbackReason);
        }
        const r = outcome.result;
        /** @type {Record<string, any>} */
        const data = {
          root,
          workerMode: outcome.mode,
          buildSystem: r.buildSystem,
          mainCandidates: r.mainCandidates,
          modules: r.modules,
          jdks: r.jdks,
          sourceFileCount: r.sourceFileCount,
          assetFileCount: r.assetFileCount,
          languageSummary: r.languageSummary,
          files: r.files,
          analyzedFileCount: r.fileAnalysis.length,
        };
        if (r.fileAnalysis.length) data.fileAnalysis = r.fileAnalysis;
        const text =
          '工程识别：' + r.buildSystem +
          '  |  入口候选: ' + (r.mainCandidates.length ? r.mainCandidates.join(', ') : '无') +
          '  |  源文件: ' + r.sourceFileCount +
          (analyzeFiles ? '  |  已分析: ' + r.fileAnalysis.length + ' 个文件' : '');
        return AgentToolResult.ok(text, data);
      } catch (e) {
        return AgentToolResult.error('工程分析失败：' + ((e && e.message) || e));
      }
    }
  );
}

module.exports = { register };
