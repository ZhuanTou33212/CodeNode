/**
 * list_directory：列出项目目录内容（Windows 安全，不使用 shell）。path 为项目内相对目录，recursive=true 递归。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { shouldSkipDir } = require('../toolFiles.cjs');

const MAX_ENTRIES = 300;

function register(registry) {
  registry.register(
    'list_directory',
    '列出项目目录内容（Windows 安全，不使用 shell）。path 为项目内相对目录（缺省根目录），recursive=true 递归。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对目录，缺省根目录' },
        recursive: { type: 'boolean', description: '是否递归列出，默认 false' },
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

      const truncated = lines.length > MAX_ENTRIES;
      const shown = truncated ? lines.slice(0, MAX_ENTRIES) : lines;
      const header = '目录 ' + (p === '.' ? '/' : p) + '（' + lines.length + (truncated ? '+' : '') + ' 项）';
      return AgentToolResult.ok(shown.length === 0 ? header + '（空）' : header + '\n' + shown.join('\n'), {
        count: lines.length,
        path: p,
      });
    }
  );
}

module.exports = { register };
