/**
 * find_files：按 glob 模式在项目内查找文件（跳过构建/缓存目录）。返回相对路径列表。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { shouldSkipDir } = require('../toolFiles.cjs');
const { globToRegExp } = require('./shared.cjs');

function walkFiles(root, dir, regex, max, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of entries) {
    if (found.length >= max) return;
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (it.name !== path.basename(root) && shouldSkipDir(it.name)) continue;
      walkFiles(root, abs, regex, max, found);
    } else if (it.isFile()) {
      const relative = path.relative(root, abs).replace(/\\/g, '/');
      if (regex.test(relative)) found.push(relative);
    }
  }
}

function register(registry) {
  registry.register(
    'find_files',
    '按 glob 模式在项目内查找文件，如 **/*.java、src/**.ts。返回相对路径列表。跳过构建/缓存目录。' +
      '超过 maxResults 时截断，可用 offset 分页。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.java' },
        maxResults: { type: 'integer', description: '最多返回条数，默认 100' },
        offset: { type: 'integer', description: '跳过前 N 条结果，用于分页，默认 0' },
      },
      required: ['pattern'],
    },
    async (context, args) => {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) return AgentToolResult.error('缺少 pattern');
      const max = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? Math.max(1, Math.floor(args.maxResults)) : 1000;
      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      const root = path.resolve(context.projectRoot());
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在：' + root);
      let regex;
      try {
        regex = globToRegExp(pattern);
      } catch (e) {
        return AgentToolResult.error('无效的 glob 模式：' + pattern);
      }
      const found = [];
      walkFiles(root, root, regex, offset + max, found);
      const total = found.length;
      if (total === 0) return AgentToolResult.ok('未找到匹配文件', { count: 0, offset: 0, files: [] });
      const page = found.slice(offset, offset + max);
      if (page.length === 0) {
        return AgentToolResult.ok('找到 ' + total + ' 个文件，但 offset=' + offset + ' 超出范围（共 ' + total + ' 条）', { count: total, offset, files: [] });
      }
      const truncated = total > offset + max;
      const shownRange = (offset + 1) + '-' + (offset + page.length);
      return AgentToolResult.ok(
        '找到 ' + total +
          (truncated ? ' 个文件，显示第 ' + shownRange + ' 条（用 offset=' + (offset + page.length) + ' 继续）：' : ' 个文件：') +
          '\n' + page.join('\n'),
        { count: total, offset, files: page }
      );
    }
  );
}

module.exports = { register };
