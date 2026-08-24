/**
 * list_directory：列出项目目录内容（Windows 安全，不使用 shell）。path 为项目内相对目录，recursive=true 递归。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { shouldSkipDir } = require('../toolFiles.cjs');

const MAX_ENTRIES = 2000;

function register(registry) {
  registry.register(
    'list_directory',
    '列出项目目录内容（Windows 安全，不使用 shell）。path 为项目内相对目录（缺省根目录），recursive=true 递归。' +
      '超过 300 项时截断，可用 offset 分页。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对目录，缺省根目录' },
        recursive: { type: 'boolean', description: '是否递归列出，默认 false' },
        offset: { type: 'integer', description: '跳过前 N 条记录，用于分页，默认 0' },
      },
      required: [],
    },
    async (context, args) => {
      let p = String(args.path || '').trim();
      if (!p) p = '.';
      const recursive = args.recursive === true;
      const root = path.resolve(context.projectRoot());
      const dir = path.resolve(root, p);
      if (dir !== root && !dir.startsWith(root + path.sep)) return AgentToolResult.error('路径越过项目边界');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return AgentToolResult.error('目录不存在：' + p);

      const lines = [];
      const collect = (base, rel, depth) => {
        let entries;
        try {
          entries = fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        } catch {
          return;
        }
        for (const it of entries) {
          const childAbs = path.join(base, it.name);
          const childRel = rel ? rel + '/' + it.name : it.name;
          if (it.isDirectory()) {
            if (shouldSkipDir(it.name)) continue;
            lines.push(childRel + '/');
            if (recursive && depth < 12) collect(childAbs, childRel, depth + 1);
          } else {
            lines.push(childRel);
          }
        }
      };
      collect(dir, p === '.' ? '' : p, 0);

      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      const truncated = lines.length > offset + MAX_ENTRIES;
      const start = Math.min(offset, lines.length);
      const shown = truncated ? lines.slice(start, start + MAX_ENTRIES) : lines.slice(start);
      const header =
        '目录 ' + (p === '.' ? '/' : p) +
        '（共 ' + lines.length + ' 项，显示第 ' + (start + 1) + '-' + (start + shown.length) + ' 项' +
        (truncated ? '，用 offset=' + (start + MAX_ENTRIES) + ' 继续' : '') + '）';
      return AgentToolResult.ok(shown.length === 0 ? header + '（空）' : header + '\n' + shown.join('\n'), {
        count: lines.length,
        offset: start,
        path: p,
      });
    }
  );
}

module.exports = { register };
