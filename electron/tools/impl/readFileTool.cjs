/**
 * read_file：读取项目内文本文件（UTF-8，自动识别语言；二进制/非 UTF-8 拒绝并说明）。
 * 超过 maxLines 截断并标注总行数；analyze=true 返回结构化摘要（import/class/function/变量）而非原文。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot, resolveFileFuzzy, detectLanguage, readTextFile, isSensitivePath } = require('./shared.cjs');
const { extractPdfText } = require('./pdfText.cjs');

const MAX_PDF_BYTES = 20 * 1024 * 1024;

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
    '读取项目内文本文件（UTF-8，自动识别语言；二进制/非 UTF-8 拒绝并说明解析方法；PDF 自动提取文字层）。' +
      '超过 maxLines 行时截断并标注总行数与可继续的 offset。' +
      'offset 为起始行号（1 基，默认 1），大文件请分段读取：先 offset=1，再 offset=201、401…' +
      'analyze=true 时返回结构化摘要（import/类/函数/变量）而非原文，适合大文件与快速定位。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        maxLines: { type: 'integer', description: '最多读取行数，默认 200' },
        offset: { type: 'integer', description: '起始行号（1 基，默认 1），大文件用 offset 分段续读' },
        analyze: { type: 'boolean', description: 'true=只返回结构摘要（不返回原文），默认 false' },
      },
      required: ['path'],
    },
    async (context, args) => {
      const relative = String(args.path || '').trim();
      if (!relative) return AgentToolResult.error('缺少 path');
      if (isSensitivePath(relative)) return AgentToolResult.error('出于凭据保护，Agent 不能读取敏感文件：' + relative);
      const root = path.resolve(context.projectRoot());
      const exact = resolveInRoot(root, relative);
      if (!exact) return AgentToolResult.error('路径越过项目边界');
      let file = exact;
      let fuzzyMatched = null;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        // 精确路径不存在：常见原因是文件名里的全角引号“”被写成了半角"（如模型构造路径时），做引号等价的宽容匹配
        const matched = resolveFileFuzzy(root, relative);
        if (matched && fs.existsSync(matched) && fs.statSync(matched).isFile()) {
          file = matched;
          fuzzyMatched = matched;
        } else {
          return AgentToolResult.error('文件不存在：' + relative);
        }
      }

      const analyzeOnly = args.analyze === true;
      const maxLines = typeof args.maxLines === 'number' && Number.isFinite(args.maxLines) ? Math.max(1, Math.floor(args.maxLines)) : 200;
      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : 1;

      const meta = { path: relative, language: detectLanguage(path.basename(file)), binary: false };
      if (fuzzyMatched) {
        meta.matched = path.relative(root, fuzzyMatched).replace(/\\/g, '/');
      }

      // PDF 特殊处理：自动提取文字层（含 CID/Identity-H + ToUnicode 的 Word 型 PDF）
      let text = null;
      const isPdf = path.extname(relative).toLowerCase() === '.pdf';
      if (isPdf) {
        meta.language = 'pdf';
        let buf;
        try {
          if (fs.statSync(file).size > MAX_PDF_BYTES) {
            return AgentToolResult.error(relative + ' PDF 过大（>20MB），无法读取', meta);
          }
          buf = fs.readFileSync(file);
        } catch (e) {
          return AgentToolResult.error('读取失败：' + ((e && e.message) || e), meta);
        }
        const pdfResult = extractPdfText(buf);
        if (!pdfResult) {
          meta.binary = true;
          return AgentToolResult.error(
            relative + ' 是扫描版或文字层不可用的 PDF，read_file 无法提取正文。' +
              '不要尝试用 execute_shell 安装 Python 库（PyPDF2/pypdf/pymupdf）或手工解析 PDF——这类 PDF 无法用它们读取。' +
              '请向用户说明，并请其提供文本/Word 版或使用 OCR 工具。',
            meta
          );
        }
        text = pdfResult.text;
      } else {
        const read = readTextFile(file, 2 * 1024 * 1024);
        if (!read.ok) {
          meta.binary = true;
          return AgentToolResult.error(relative + ' 是二进制或不可读文件，不能用 read_file 读取；请按建议解析：' + binarySuggestion(relative), meta);
        }
        text = read.text;
      }
      const lines = text.split('\n');
      meta.lineCount = lines.length;
      const fuzzyNote = fuzzyMatched
        ? '（注意：路径中的全角引号“”被写成了半角"导致未精确匹配，已自动定位到实际文件 ' + meta.matched + '，后续请使用该实际路径）\n'
        : '';

      if (analyzeOnly) {
        const summary = analyzeStructure(text, maxLines);
        meta.truncated = summary.lineCount > maxLines;
        return AgentToolResult.ok(
          fuzzyNote + relative + '（' + summary.lineCount + ' 行，结构摘要）\n' +
            (summary.imports.length ? 'imports:\n  ' + summary.imports.slice(0, 40).join('\n  ') + '\n' : '') +
            (summary.classes.length ? 'classes: ' + summary.classes.join(', ') + '\n' : '') +
            (summary.functions.length ? 'functions:\n  ' + summary.functions.join('\n  ') + '\n' : '') +
            (summary.variables.length ? 'variables: ' + summary.variables.join(', ') + '\n' : ''),
          meta
        );
      }

      const startIdx = Math.max(0, offset - 1);
      if (startIdx >= lines.length) {
        meta.offset = offset;
        meta.startLine = lines.length;
        meta.endLine = lines.length;
        return AgentToolResult.ok(
          fuzzyNote + relative + '（共 ' + lines.length + ' 行）offset=' + offset + ' 超出文件总行数，无更多内容可读取',
          meta
        );
      }
      const endIdx = Math.min(lines.length, startIdx + maxLines);
      const content = lines.slice(startIdx, endIdx).join('\n');
      const truncated = endIdx < lines.length;
      meta.truncated = truncated;
      meta.offset = offset;
      meta.startLine = Math.min(lines.length, startIdx + 1);
      meta.endLine = endIdx;
      let suffix = '';
      if (truncated) {
        suffix = '\n…（已显示第 ' + meta.startLine + '-' + meta.endLine + ' 行，共 ' + lines.length + ' 行，用 offset=' + (endIdx + 1) + ' 继续读取剩余）';
      } else if (offset > 1) {
        suffix = '\n（已显示第 ' + meta.startLine + '-' + meta.endLine + ' 行，共 ' + lines.length + ' 行）';
      }
      return AgentToolResult.ok(
        fuzzyNote + relative + '（' + lines.length + ' 行，' + (meta.language === 'unknown' ? '未知类型' : meta.language) + '）\n' + content + suffix,
        meta
      );
    }
  );
}

module.exports = { register };
