/**
 * read_file：读取项目内文本文件（UTF-8，自动识别语言；二进制/非 UTF-8 拒绝并说明）。
 * 超过 maxLines 截断并标注总行数；analyze=true 返回结构化摘要（import/class/function/变量）而非原文。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot, detectLanguage, readTextFile } = require('./shared.cjs');

function binarySuggestion(relative) {
  const ext = path.extname(relative).toLowerCase();
  switch (ext) {
    case '.class':
      return '用 execute_shell 执行 javap -p <文件> 反汇编';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.bmp':
    case '.webp':
    case '.ico':
      return '图片，需用图像工具查看';
    case '.jar':
    case '.zip':
    case '.cnode':
      return '归档，先解压再分析内部条目';
    case '.pdf':
    case '.docx':
    case '.xlsx':
    case '.pptx':
      return '文档格式，需专用解析器';
    default:
      return '用 scan_project 或专用工具处理';
  }
}

function analyzeStructure(text, maxLines) {
  const lines = text.split('\n');
  const imports = [];
  const classes = [];
  const functions = [];
  const variables = [];
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const im = line.match(/^(?:import|from|using|require\s*\(|include\s+|#include\s*<)/);
    if (im) {
      imports.push(line.length > 120 ? line.slice(0, 120) : line);
      continue;
    }
    const cl = line.match(/^\s*(?:public\s+|private\s+|protected\s+|export\s+|class\s|interface\s|trait\s|type\s+|struct\s+)[^{]*?\b(class|interface|trait|struct|type)\s+([A-Za-z_$][\w$]*)/);
    if (cl) {
      classes.push(cl[2]);
      continue;
    }
    const fn = line.match(/\b(def|func|function|fun|const\s+\w+\s*=\s*\(|public\s+\w+\s+\w+\s*\(|private\s+\w+\s+\w+\s*\(|protected\s+\w+\s+\w+\s*\()/);
    if (fn) {
      functions.push(line.length > 120 ? line.slice(0, 120) : line);
    }
    const vr = line.match(/^\s*(?:let|var|const|val)\s+([A-Za-z_$][\w$]*)/);
    if (vr) variables.push(vr[1]);
  }
  return { imports, classes: [...new Set(classes)], functions: functions.slice(0, 60), variables: [...new Set(variables)].slice(0, 80), lineCount: lines.length };
}

function register(registry) {
  registry.register(
    'read_file',
    '读取项目内文本文件（UTF-8，自动识别语言；二进制/非 UTF-8 拒绝并说明解析方法）。超过 maxLines 行时截断并标注总行数。' +
      'analyze=true 时返回结构化摘要（import/类/函数/变量）而非原文，适合大文件与快速定位。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        maxLines: { type: 'integer', description: '最多读取行数，默认 200' },
        analyze: { type: 'boolean', description: 'true=只返回结构摘要（不返回原文），默认 false' },
      },
      required: ['path'],
    },
    async (context, args) => {
      const relative = String(args.path || '').trim();
      if (!relative) return AgentToolResult.error('缺少 path');
      const root = path.resolve(context.projectRoot());
      const file = resolveInRoot(root, relative);
      if (!file) return AgentToolResult.error('路径越过项目边界');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return AgentToolResult.error('文件不存在：' + relative);

      const analyzeOnly = args.analyze === true;
      const maxLines = typeof args.maxLines === 'number' && Number.isFinite(args.maxLines) ? Math.max(1, Math.floor(args.maxLines)) : 200;

      const meta = { path: relative, language: detectLanguage(path.basename(file)), binary: false };
      const read = readTextFile(file, 2 * 1024 * 1024);
      if (!read.ok) {
        meta.binary = true;
        return AgentToolResult.error(relative + ' 是二进制或不可读文件，不能用 read_file 读取；请按建议解析：' + binarySuggestion(relative), meta);
      }
      const lines = read.text.split('\n');
      meta.lineCount = lines.length;

      if (analyzeOnly) {
        const summary = analyzeStructure(read.text, maxLines);
        meta.truncated = summary.lineCount > maxLines;
        return AgentToolResult.ok(
          relative + '（' + summary.lineCount + ' 行，结构摘要）\n' +
            (summary.imports.length ? 'imports:\n  ' + summary.imports.slice(0, 40).join('\n  ') + '\n' : '') +
            (summary.classes.length ? 'classes: ' + summary.classes.join(', ') + '\n' : '') +
            (summary.functions.length ? 'functions:\n  ' + summary.functions.join('\n  ') + '\n' : '') +
            (summary.variables.length ? 'variables: ' + summary.variables.join(', ') + '\n' : ''),
          meta
        );
      }

      const truncated = lines.length > maxLines;
      const content = lines.slice(0, maxLines).join('\n');
      const suffix = truncated ? '\n…（截断，共 ' + lines.length + ' 行）' : '';
      meta.truncated = truncated;
      return AgentToolResult.ok(
        relative + '（' + lines.length + ' 行，' + (meta.language === 'unknown' ? '未知类型' : meta.language) + '）\n' + content + suffix,
        meta
      );
    }
  );
}

module.exports = { register };
