/**
 * read_file：读取项目内 UTF-8 文本、PDF 文字层与现代 Office 文档正文。
 * 超过 maxLines 截断并标注总行数；analyze=true 返回结构化摘要（import/class/function/变量）而非原文。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 第 9 项：文本分支的读取上限（含原因区分报错）。2MB 是量测后的取舍：同步读 2MB 实测 7ms，
// worker 固定往返约 24ms —— 搬 worker 是净变慢，所以这里用上限把最坏情况钉住。
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot, resolveFileFuzzy, detectLanguage, readTextFile, isSensitivePath } = require('./shared.cjs');
const fsRunner = require('../fsRunner.cjs');

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_READ_LINES_PER_CALL = 500;
const DEFAULT_READ_CHARS_PER_CALL = 24000;
const MAX_READ_CHARS_PER_CALL = 48000;

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
    case '.doc':
    case '.xls':
    case '.ppt':
      return '旧版二进制 Office 格式，需先转换为 DOCX/XLSX/PPTX 或 UTF-8 文本';
    case '.pdf':
    case '.docx':
    case '.docm':
    case '.xlsx':
    case '.xlsm':
    case '.pptx':
    case '.pptm':
      return '文档文字不可提取，可能加密、损坏或缺少文字层';
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
    '读 UTF-8 文本及 PDF、DOCX、XLSX、PPTX；offset/maxLines/charOffset 分页，analyze=true 返回结构摘要。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        maxLines: { type: 'integer', description: '最多读取行数，默认 200，单次最多 500；更大的文件用 offset 分段读取' },
        maxChars: { type: 'integer', description: '本次最多返回字符数，默认 24000，单次最多 48000；超长行可用返回的 charOffset 续读' },
        offset: { type: 'integer', description: '起始行号（1 基，默认 1），大文件用 offset 分段续读' },
        charOffset: { type: 'integer', description: '从 offset 指定行的第几个字符继续（0 基），用于续读超长行' },
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

      // #17：敏感判定必须落在 **realpath** 上。resolveInRoot 只保证 realpath 在根内，
      // 但仓库自带的符号链接（`notes.md -> .env`）在它眼里完全合法；只查模型给的 relative
      // 等于给凭据开了一条「改个名字就读」的通道，而 read_file 是凭据直接外发进上下文的那条路。
      if (isSensitivePath(path.relative(fs.realpathSync(root), fs.realpathSync(file)))) {
        return AgentToolResult.error('出于凭据保护，Agent 不能读取敏感文件：' + relative);
      }

      const analyzeOnly = args.analyze === true;
      const maxLines = typeof args.maxLines === 'number' && Number.isFinite(args.maxLines)
        ? Math.max(1, Math.min(MAX_READ_LINES_PER_CALL, Math.floor(args.maxLines)))
        : 200;
      const maxChars = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)
        ? Math.max(1000, Math.min(MAX_READ_CHARS_PER_CALL, Math.floor(args.maxChars)))
        : DEFAULT_READ_CHARS_PER_CALL;
      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : 1;
      const requestedCharOffset = typeof args.charOffset === 'number' && Number.isFinite(args.charOffset)
        ? Math.max(0, Math.floor(args.charOffset))
        : 0;

      const meta = { path: relative, language: detectLanguage(path.basename(file)), binary: false };
      if (fuzzyMatched) {
        meta.matched = path.relative(root, fuzzyMatched).replace(/\\/g, '/');
      }

      // 文档特殊处理：PDF 文字层与现代 Office 正文经文件 worker 提取。
      let text = null;
      const ext = path.extname(relative).toLowerCase();
      const isPdf = ext === '.pdf';
      const isOffice = ['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm'].includes(ext);
      if (isPdf) {
        meta.language = 'pdf';
        // P7 收口：PDF/Office 分支是 read_file 里的重活 —— 读（≤20MB）之后还要
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
        meta.sourceSha256 = pdfResult.sha256;
      } else if (isOffice) {
        meta.language = ext.slice(1);
        const outcome = await fsRunner.runFsTask(
          'readOfficeText',
          { path: file, maxBytes: MAX_PDF_BYTES },
          { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
        );
        if (outcome.cancelled || outcome.timedOut) {
          return AgentToolResult.failure('CANCELLED', 'Office 文档解析已取消（用户停止）。', { cancelled: true, path: relative });
        }
        if (outcome.mode === 'sync-fallback') {
          context.audit('read_file(Office) worker 不可用，已退回主线程同步解析：' + outcome.fallbackReason);
        }
        const officeResult = outcome.result;
        if (!officeResult || officeResult.ok !== true) {
          meta.binary = true;
          if (officeResult && officeResult.errorKind === 'too-large') {
            return AgentToolResult.error(relative + ' 文档过大（>' + officeResult.limitMb + 'MB），无法读取', meta);
          }
          if (officeResult && officeResult.errorKind === 'read-failed') {
            return AgentToolResult.error(officeResult.error, meta);
          }
          return AgentToolResult.error(relative + ' 的文字无法提取（文件可能损坏、加密或没有可读正文）。', meta);
        }
        text = officeResult.text;
        meta.sourceSha256 = officeResult.sha256;
        meta.extractedTruncated = officeResult.truncated === true;
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
        meta.sourceSha256 = read.sha256;
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
      const bodyLines = [];
      let bodyChars = 0;
      let lastLine = startIdx;
      let nextRead = null;
      let firstCharOffset = requestedCharOffset;
      if (firstCharOffset > lines[startIdx].length) firstCharOffset = lines[startIdx].length;
      for (let lineIndex = startIdx; lineIndex < endIdx; lineIndex += 1) {
        const lineNumber = lineIndex + 1;
        const charOffset = lineIndex === startIdx ? firstCharOffset : 0;
        const remainingLine = lines[lineIndex].slice(charOffset);
        const separator = bodyLines.length ? 1 : 0;
        const room = maxChars - bodyChars - separator;
        if (room <= 0) {
          nextRead = { offset: lineNumber, charOffset };
          break;
        }
        if (separator) bodyChars += separator;
        if (remainingLine.length > room) {
          bodyLines.push(remainingLine.slice(0, room));
          bodyChars += room;
          lastLine = lineNumber;
          nextRead = { offset: lineNumber, charOffset: charOffset + room };
          break;
        }
        bodyLines.push(remainingLine);
        bodyChars += remainingLine.length;
        lastLine = lineNumber;
      }
      if (!nextRead && endIdx < lines.length) nextRead = { offset: endIdx + 1, charOffset: 0 };
      const content = bodyLines.join('\n');
      const truncated = !!nextRead;
      meta.truncated = truncated;
      meta.offset = offset;
      meta.charOffset = firstCharOffset;
      meta.startLine = Math.min(lines.length, startIdx + 1);
      meta.endLine = lastLine;
      if (meta.sourceSha256 && !isPdf) {
        meta.sourceRangeSha256 = 'sha256:' + crypto.createHash('sha256')
          .update(lines.slice(startIdx, lastLine).join('\n').replace(/\r(?=\n|$)/g, ''), 'utf8').digest('hex');
      }
      meta.nextOffset = nextRead ? nextRead.offset : null;
      meta.nextCharOffset = nextRead ? nextRead.charOffset : null;
      let suffix = '';
      if (nextRead) {
        suffix = '\n…（本次最多返回 ' + maxChars + ' 字符或 ' + maxLines + ' 行；继续读取请用 offset=' + nextRead.offset +
          (nextRead.charOffset ? '、charOffset=' + nextRead.charOffset : '') + '，文件共 ' + lines.length + ' 行）';
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
