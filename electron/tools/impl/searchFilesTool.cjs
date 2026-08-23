/**
 * search_files：跨项目文件按正则搜索内容（UTF-8 文本），返回 文件:行号:内容。跳过构建/缓存/二进制。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { shouldSkipDir, isBinaryFileName } = require('../toolFiles.cjs');
const { globToRegExp } = require('./shared.cjs');

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function walkFiles(root, dir, fileRegex, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of entries) {
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (it.name !== path.basename(root) && shouldSkipDir(it.name)) continue;
      walkFiles(root, abs, fileRegex, onFile);
    } else if (it.isFile()) {
      const relative = path.relative(root, abs).replace(/\\/g, '/');
      if (fileRegex && !fileRegex.test(relative)) continue;
      onFile(abs, relative);
    }
  }
}

function register(registry) {
  registry.register(
    'search_files',
    '跨项目文件按正则搜索内容（UTF-8 文本），返回 文件:行号:内容。path 限定子目录，filePattern 限定文件 glob，' +
      'caseSensitive 默认 false。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '项目内子目录，缺省整个项目' },
        filePattern: { type: 'string', description: '限定文件的 glob，如 *.java' },
        maxResults: { type: 'integer', description: '最多返回条数，默认 100' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
      },
      required: ['pattern'],
    },
    async (context, args) => {
      const patternText = String(args.pattern || '').trim();
      if (!patternText) return AgentToolResult.error('缺少 pattern');
      const max = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? Math.max(1, Math.floor(args.maxResults)) : 100;
      const caseSensitive = args.caseSensitive === true;
      const root = path.resolve(context.projectRoot());
      const subDir = String(args.path || '').trim();
      const start = subDir ? path.resolve(root, subDir) : root;
      if (start !== root && !start.startsWith(root + path.sep)) return AgentToolResult.error('路径越过项目边界');
      if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) return AgentToolResult.error('目录不存在：' + (subDir || '.'));
      let regex;
      try {
        regex = new RegExp(patternText, caseSensitive ? '' : 'i');
      } catch (e) {
        return AgentToolResult.error('无效正则：' + ((e && e.message) || e));
      }
      const filePattern = String(args.filePattern || '').trim();
      let fileRegex = null;
      if (filePattern) {
        try {
          fileRegex = globToRegExp(filePattern);
        } catch {
          return AgentToolResult.error('无效 filePattern：' + filePattern);
        }
      }
      const matches = [];
      const skipCheck = new Set();
      walkFiles(start, start, fileRegex, (abs, relative) => {
        if (matches.length >= max) return;
        if (isBinaryFileName(path.basename(abs))) return;
        let size;
        try {
          size = fs.statSync(abs).size;
        } catch {
          return;
        }
        if (size > MAX_FILE_BYTES) return;
        let lines;
        try {
          const buf = fs.readFileSync(abs);
          if (buf.includes(0)) return;
          lines = buf.toString('utf-8').split('\n');
        } catch {
          return;
        }
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= max) return;
          if (regex.test(lines[i])) {
            matches.push(relative + ':' + (i + 1) + ': ' + lines[i].trim());
          }
        }
      });
      void skipCheck;
      if (matches.length === 0) return AgentToolResult.ok('未找到匹配内容', { count: 0 });
      return AgentToolResult.ok('找到 ' + matches.length + ' 处匹配：\n' + matches.join('\n'), { count: matches.length });
    }
  );
}

module.exports = { register };
