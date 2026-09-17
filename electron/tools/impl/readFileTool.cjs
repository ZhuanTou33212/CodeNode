/**
 * read_file：读取项目内文本文件（UTF-8，自动识别语言；二进制/非 UTF-8 拒绝并说明）。
 * 超过 maxLines 截断并标注总行数；analyze=true 返回结构化摘要（import/class/function/变量）而非原文。
 */
'use strict';

const fs = require('fs');
const path = require('path');
// 第 9 项：文本分支的读取上限（含原因区分报错）。2MB 是量测后的取舍：同步读 2MB 实测 7ms，
// worker 固定往返约 24ms —— 搬 worker 是净变慢，所以这里用上限把最坏情况钉住。
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot, resolveFileFuzzy, detectLanguage, readTextFile, isSensitivePath } = require('./shared.cjs');
const fsRunner = require('../fsRunner.cjs');

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
        // P7 收口：PDF 分支是 read_file 里**唯一**的重活 —— 读（≤20MB，实测同步 ~6.6ms）之后还要
        // 跑自研解析（inflate + CMap + 文本重建；实测一个 60MB 文本流光 inflate 就 ~82ms，
        // 真实 PDF 100–300ms 量级）。worker 固定往返只有 ~24ms，所以这是正收益：主线程不再被冻住，
        // 取消也能真的 terminate。
        // 对照：文本分支（≤2MB，实测同步读 1.3ms）**刻意不搬** —— 那点读取比 worker 开销小一个
        // 数量级（实测 18×），搬过去是净变慢。别为了「统一」把它也搬走。
        const outcome = await fsRunner.runFsTask(
          'readPdfText',
          { path: file, maxBytes: MAX_PDF_BYTES },
          { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
        );
        if (outcome.cancelled || outcome.timedOut) {
          return AgentToolResult.failure('CANCELLED', 'PDF 解析已取消（用户停止）。', { cancelled: true, path: relative });
        }
        if (outcome.mode === 'sync-fallback') {
          context.audit('read_file(PDF) worker 不可用，已退回主线程同步解析：' + outcome.fallbackReason);
        }
        const pdfResult = outcome.result;
        if (!pdfResult || pdfResult.ok !== true) {
          meta.binary = true;
          if (pdfResult && pdfResult.errorKind === 'too-large') {
            return AgentToolResult.error(relative + ' PDF 过大（>' + pdfResult.limitMb + 'MB），无法读取', meta);
          }
          if (pdfResult && pdfResult.errorKind === 'read-failed') {
            return AgentToolResult.error(pdfResult.error, meta);
          }
          return AgentToolResult.error(
            relative + ' 是扫描版或文字层不可用的 PDF，read_file 无法提取正文。' +
              '不要尝试用 execute_shell 安装 Python 库（PyPDF2/pypdf/pymupdf）或手工解析 PDF——这类 PDF 无法用它们读取。' +
              '请向用户说明，并请其提供文本/Word 版或使用 OCR 工具。',
            meta
          );
        }
        text = pdfResult.text;
      } else {
        const read = readTextFile(file, MAX_TEXT_BYTES);
        if (!read.ok) {
          // 第 9 项：超上限 / 二进制 / 非 UTF-8 是**三种不同**情况，必须分开报。
          // 此前统一渲染成「是二进制或不可读文件」—— 实测 20MB 的纯文本 .txt 也被这么说，
          // 模型于是去试别的解析方式（甚至装 Python 库）把「文件太大」当成「文件坏了」。
          const reason = String(read.error || '');
          const overLimit = reason.includes('字节上限');
          meta.binary = !overLimit;
          if (overLimit) {
            return AgentToolResult.error(
              relative + ' ' + reason + '（read_file 文本分支上限 ' + Math.round(MAX_TEXT_BYTES / 1024 / 1024) + 'MB）。' +
                '请改用 offset/maxLines 分段读取，或用 search_files / find_files 先定位目标片段，不要当成二进制文件处理。',
              meta
            );
          }
          return AgentToolResult.error(relative + ' 是二进制或不可读文件，不能用 read_file 读取（' + reason + '）；请按建议解析：' + binarySuggestion(relative), meta);
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
