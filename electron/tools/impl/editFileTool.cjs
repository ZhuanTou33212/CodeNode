'use strict';
const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot, checkExpectedHash, sha256OfFile } = require('./shared.cjs');
const { atomicWriteFile } = require('../../atomicFile.cjs');
const { fileChangeReview } = require('../fileChangeReview.cjs');
const editing = require('../../safeEditing.cjs');
const { config } = require('../../editingSettings.cjs');

function register(registry) {
  const changeSchema = { type: 'object', properties: {
    oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' }, occurrence: { type: 'integer', minimum: 0 },
  }, required: ['oldText', 'newText'], additionalProperties: false };
  registry.register('edit_file', '原子精确替换。默认原文须唯一匹配；occurrence=0 明确替换全部。replacements 可顺序批量替换，整批检查语法后一次落盘。版本变化、歧义或无效语法均拒写。', {
    type: 'object', properties: {
      path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' },
      occurrence: { type: 'integer', minimum: 0 },
      replacements: { type: 'array', minItems: 1, maxItems: 100, items: changeSchema },
      expectedSha256: { type: 'string', description: '读取版本哈希；不匹配拒写' },
    }, required: ['path'], anyOf: [{ required: ['oldText', 'newText'] }, { required: ['replacements'] }],
  }, async (context, args) => {
    const relative = String(args.path || '').trim();
    const file = resolveInRoot(path.resolve(context.projectRoot()), relative);
    if (!relative || !file) return AgentToolResult.error('路径越过项目边界或缺少 path');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return AgentToolResult.error('文件不存在：' + relative);
    try {
      if (args.replacements && (args.oldText != null || args.newText != null || args.occurrence != null)) return AgentToolResult.error('单次替换与 replacements 不能同时使用');
      if (args.expectedSha256) {
        const guard = checkExpectedHash(file, args.expectedSha256);
        if (!guard.ok) return AgentToolResult.failure('CONFLICT_STALE', '文件版本已变化，请重新读取后编辑', { path: relative, actual: guard.actual });
      }
      const before = editing.snapshot(file);
      const changes = args.replacements || [{ oldText: args.oldText, newText: args.newText, occurrence: args.occurrence }];
      const { updated, replaced } = editing.replaceText(before.text, changes);
      const settings = context.editingConfig ? context.editingConfig() : config.defaults;
      const syntax = editing.validateCandidate(relative, before.text, updated, settings);
      if (!await context.confirm(ConfirmationLevel.WRITE, '修改文件 ' + relative + '（替换 ' + replaced + ' 处）', fileChangeReview(before.text, updated, true).diff.slice(0, 1200))) return AgentToolResult.error('已取消修改');
      const current = checkExpectedHash(file, before.sha256);
      if (!current.ok) return AgentToolResult.failure('CONFLICT_STALE', '确认期间文件已变化，已放弃写入，请重新读取', { path: relative, actual: current.actual });
      fs.copyFileSync(file, file + '.bak');
      atomicWriteFile(file, updated, 'utf8', { expectedSha256: before.sha256 });
      context.audit('edit_file ' + relative + ' replaced=' + replaced);
      context.notifyFileChange(relative, 'modify', '替换 ' + replaced + ' 处');
      return AgentToolResult.ok('已替换 ' + replaced + ' 处：' + relative, { path: relative, replaced,
        review: fileChangeReview(before.text, updated, true), sha256: sha256OfFile(file), syntax });
    } catch (error) {
      if (error.code && !['CONFLICT_STALE', 'ARG_SCHEMA'].includes(error.code)) return AgentToolResult.error('编辑失败：' + error.message, { path: relative });
      return AgentToolResult.failure(error.code === 'CONFLICT_STALE' ? 'CONFLICT_STALE' : 'ARG_SCHEMA', error.message, { path: relative, syntax: error.syntax });
    }
  });
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ['edit_file']);
}
module.exports = { register };
