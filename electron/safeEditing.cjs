'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('./editingSettings.cjs');

function snapshot(file) {
  if (!fs.existsSync(file)) return { text: '', sha256: 'absent', existed: false };
  const bytes = fs.readFileSync(file);
  if (bytes.length > config.limits.maxFileBytes) throw new Error('文件过大，请使用局部编辑或外部编辑器');
  if (bytes.includes(0)) throw new Error('不能作为 UTF-8 文本编辑二进制文件');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { text, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), existed: true };
}

function replaceText(content, changes) {
  let updated = content, replaced = 0;
  for (const change of changes) {
    if (!change || typeof change.oldText !== 'string' || !change.oldText || typeof change.newText !== 'string') throw Object.assign(new Error('每个替换必须提供非空 oldText 和明确的 newText；删除请传空字符串'), { code: 'ARG_SCHEMA' });
    const positions = [];
    for (let from = 0;;) {
      const found = updated.indexOf(change.oldText, from);
      if (found < 0) break;
      positions.push(found); from = found + change.oldText.length;
    }
    if (!positions.length) throw new Error('未找到目标原文，请重新读取文件');
    if (change.occurrence == null && positions.length !== 1) throw Object.assign(new Error('原文匹配 ' + positions.length + ' 处；请扩大上下文或明确 occurrence（0 表示全部）'), { code: 'ARG_SCHEMA' });
    const occurrence = change.occurrence;
    if (occurrence != null && (!Number.isInteger(occurrence) || occurrence < 0 || occurrence > positions.length)) throw new Error('指定的 occurrence 不存在');
    if (occurrence === 0) { updated = updated.split(change.oldText).join(change.newText); replaced += positions.length; }
    else {
      const start = positions[(occurrence || 1) - 1];
      updated = updated.slice(0, start) + change.newText + updated.slice(start + change.oldText.length); replaced++;
    }
  }
  return { updated, replaced };
}

function syntaxCheck(file, content) {
  if (/\.json$/i.test(file)) {
    try { JSON.parse(content.replace(/^\uFEFF/, '')); return { status: 'passed', diagnostics: [] }; }
    catch (error) { return { status: 'failed', diagnostics: [{ message: error.message }] }; }
  }
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)) return { status: 'not_supported', diagnostics: [] };
  const ts = require('typescript');
  const kind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\.jsx$/i.test(file) ? ts.ScriptKind.JSX : /\.[cm]?ts$/i.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
  const options = { noResolve: true, noLib: true, allowJs: true, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === file ? source : undefined;
  const diagnostics = ts.createProgram([file], options, host).getSyntacticDiagnostics(source);
  return { status: diagnostics.length ? 'failed' : 'passed', diagnostics: diagnostics.slice(0, 10).map((item) => {
    const point = source.getLineAndCharacterOfPosition(item.start || 0);
    return { line: point.line + 1, column: point.character + 1, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') };
  }) };
}

function validateCandidate(file, before, after, settings, wholeFile = false) {
  if (Buffer.byteLength(after, 'utf8') > config.limits.maxFileBytes) throw new Error('候选文件超过编辑大小上限');
  const oldLines = before.split(/\r?\n/).length, newLines = after.split(/\r?\n/).length;
  if (settings.protectLongFiles && oldLines >= settings.longFileLines) {
    if (wholeFile) throw Object.assign(new Error('已有长文件禁止整体覆盖，请用 edit_file 局部或批量精确替换'), { code: 'ARG_SCHEMA' });
    if ((oldLines - newLines) / oldLines > settings.maxDeletedRatio) throw Object.assign(new Error('删除行数超过长文件保护阈值，请拆分修改或在安全编辑设置调整保护策略'), { code: 'ARG_SCHEMA' });
  }
  const syntax = settings.checkSyntax ? syntaxCheck(file, after) : { status: 'disabled', diagnostics: [] };
  if (syntax.status === 'failed') throw Object.assign(new Error('候选语法无效，未写入：' + syntax.diagnostics.map((item) => item.message).join('；')), { code: 'ARG_SCHEMA', syntax });
  return syntax;
}

module.exports = { snapshot, replaceText, syntaxCheck, validateCandidate };
