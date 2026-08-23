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
    '按 glob 模式在项目内查找文件，如 **/*.java、src/**.ts。返回相对路径列表。跳过构建/缓存目录。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.java' },
        maxResults: { type: 'integer', description: '最多返回条数，默认 100' },
      },
      required: ['pattern'],
    },
    async (context, args) => {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) return AgentToolResult.error('缺少 pattern');
      const max = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? Math.max(1, Math.floor(args.maxResults)) : 100;
      const root = path.resolve(context.projectRoot());
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在：' + root);
      let regex;
      try {
        regex = globToRegExp(pattern);
      } catch (e) {
        return AgentToolResult.error('无效的 glob 模式：' + pattern);
      }
      const found = [];
      walkFiles(root, root, regex, max, found);
      if (found.length === 0) return AgentToolResult.ok('未找到匹配文件', { count: 0 });
      const truncated = found.length >= max;
      return AgentToolResult.ok(
        '找到 ' + found.length + (truncated ? '+' : '') + ' 个文件：\n' + found.join('\n'),
        { count: found.length, files: found }
      );
    }
  );
}

module.exports = { register };
