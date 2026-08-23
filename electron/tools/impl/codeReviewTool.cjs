/**
 * code_review：本地规则引擎静态代码审查（硬编码密码、空指针风险、过长方法、TODO 遗留等），确定性输出。
 * 支持 code 参数或 path 参数读取文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot, readTextFile } = require('./shared.cjs');

const PASSWORD_PATTERN = /(password|passwd|pwd|secret|api_key|apikey|token)\s*[:=]\s*['"][^'"]{4,}['"]/gi;
const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/gi;
const NULL_CHECK_PATTERN = /\.equals\s*\(\s*null\s*\)/g;
const CHAIN_PATTERN = /\b([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\(/g;

function lineOf(code, offset) {
  let line = 1;
  for (let i = 0; i < Math.min(offset, code.length); i++) {
    if (code[i] === '\n') line++;
  }
  return line;
}

function isMethodSignature(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;
  return (
    trimmed.includes('(') &&
    trimmed.includes(')') &&
    trimmed.includes('{') &&
    /(public|private|protected|static|def |func |fun )/.test(trimmed)
  );
}

function braceDelta(line) {
  let delta = 0;
  for (const c of line) {
    if (c === '{') delta++;
    else if (c === '}') delta--;
  }
  return delta;
}

function findLongMethods(code, maxLines, findings) {
  const lines = code.split('\n');
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && isMethodSignature(lines[i])) {
      start = i;
      depth = braceDelta(lines[i]);
      continue;
    }
    if (start >= 0) {
      depth += braceDelta(lines[i]);
      if (depth <= 0) {
        const length = i - start + 1;
        if (length > maxLines) {
          addFinding(findings, 'complexity', '方法过长（' + length + ' 行，阈值 ' + maxLines + '）', start + 1);
        }
        start = -1;
      }
    }
  }
}

function isLikelyParameter(code, name) {
  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (
      trimmed.includes('(' + name + ',') ||
      trimmed.includes(',' + name + ')') ||
      trimmed.includes('String ' + name) ||
      trimmed.includes('Object ' + name) ||
      trimmed.includes('def ' + name) ||
      trimmed.includes('(' + name + ':')
    ) {
      return true;
    }
  }
  return false;
}

function addFinding(findings, severity, message, line) {
  findings.push({ severity, message, line });
}

function register(registry) {
  registry.register(
    'code_review',
    '本地规则引擎静态代码审查：硬编码密码/密钥、空指针风险、过长方法、TODO 遗留。code 与 path 二选一。',
    {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要审查的代码文本' },
        path: { type: 'string', description: '项目内相对路径，与 code 二选一' },
        maxMethodLines: { type: 'integer', description: '过长方法阈值，默认 200' },
      },
      required: [],
    },
    async (context, args) => {
      let code = null;
      let relative = null;
      const codeObj = args.code;
      if (codeObj != null && String(codeObj).trim() !== '') {
        code = String(codeObj);
      } else {
        const pathObj = args.path;
        if (pathObj == null || String(pathObj).trim() === '') {
          return AgentToolResult.error('需要提供 code 或 path');
        }
        relative = String(pathObj);
        const root = path.resolve(context.projectRoot());
        const file = resolveInRoot(root, relative);
        if (!file) return AgentToolResult.error('路径越过项目边界');
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return AgentToolResult.error('文件不存在：' + relative);
        const read = readTextFile(file);
        if (!read.ok) return AgentToolResult.error(read.error);
        code = read.text;
      }
      const maxMethodLines = typeof args.maxMethodLines === 'number' && Number.isFinite(args.maxMethodLines) ? Math.max(1, Math.floor(args.maxMethodLines)) : 200;
      const findings = [];

      let m;
      PASSWORD_PATTERN.lastIndex = 0;
      while ((m = PASSWORD_PATTERN.exec(code))) addFinding(findings, 'security', '疑似硬编码密码/密钥', lineOf(code, m.index));
      TODO_PATTERN.lastIndex = 0;
      while ((m = TODO_PATTERN.exec(code))) addFinding(findings, 'todo', '遗留 TODO/FIXME', lineOf(code, m.index));
      NULL_CHECK_PATTERN.lastIndex = 0;
      while ((m = NULL_CHECK_PATTERN.exec(code))) addFinding(findings, 'null-safety', '对 null 调用 equals（空指针风险）', lineOf(code, m.index));
      findLongMethods(code, maxMethodLines, findings);
      CHAIN_PATTERN.lastIndex = 0;
      while ((m = CHAIN_PATTERN.exec(code))) {
        const receiver = m[1];
        if (isLikelyParameter(code, receiver)) {
          addFinding(findings, 'null-safety', '可能的空指针风险：对参数 ' + receiver + ' 的多级调用', lineOf(code, m.index));
        }
      }

      const data = { findings, total: findings.length, source: relative == null ? 'inline' : relative };
      if (findings.length === 0) return AgentToolResult.ok('未发现明显问题', data);
      const lines = ['发现 ' + findings.length + ' 个问题：'];
      for (const f of findings) {
        lines.push('• [' + f.severity + '] ' + f.message + '（行 ' + f.line + '）');
      }
      return AgentToolResult.ok(lines.join('\n'), data);
    }
  );
}

module.exports = { register };
