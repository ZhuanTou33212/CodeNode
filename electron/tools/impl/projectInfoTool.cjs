/**
 * project_info：识别给定（或当前）项目目录的工程信息——构建系统、模块、源集、入口候选、语言概览。
 * path 缺省时使用当前项目根。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { detectProjectInfo } = require('../projectScan.cjs');

function register(registry) {
  registry.register(
    'project_info',
    '识别项目目录的工程信息：构建系统（npm/Maven/Gradle/Python/Go/纯项目）、模块/源目录列表、入口候选文件、' +
      '语言分布概览与文件总数。path 缺省使用当前项目目录。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目根目录（可选，缺省当前项目）' },
      },
      required: [],
    },
    async (context, args) => {
      const rawPath = String(args.path || '').trim();
      const root = rawPath ? path.resolve(rawPath) : path.resolve(context.projectRoot());
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在: ' + root);
      const info = detectProjectInfo(root);
      context.audit('project_info root=' + root);
      const lines = [
        '构建系统: ' + info.buildSystem,
        '模块/源目录: ' + (info.modules.length ? info.modules.join(', ') : '无'),
        '入口候选: ' + (info.mainCandidates.length ? info.mainCandidates.join(', ') : '无'),
        '文件总数: ' + info.fileCount,
      ];
      return AgentToolResult.ok(lines.join('  |  '), { ...info, root });
    }
  );
}

module.exports = { register };
