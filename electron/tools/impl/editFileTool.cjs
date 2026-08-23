/**
 * edit_file：精确替换项目文件中的某段文本（oldText→newText）。occurrence 指定第几次出现（1 起），缺省替换全部。
 * 修改前确认（WRITE 级），自动备份 .bak。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot, readTextFile } = require('./shared.cjs');

function indexOfOccurrence(content, needle, occurrence) {
  let from = 0;
  for (let i = 1; i <= occurrence; i++) {
    const index = content.indexOf(needle, from);
    if (index < 0) return -1;
    if (i === occurrence) return index;
    from = index + needle.length;
  }
  return -1;
}

function countOccurrences(content, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const index = content.indexOf(needle, from);
    if (index < 0) break;
    count++;
    from = index + needle.length;
  }
  return count;
}

function abbreviate(text) {
  const trimmed = String(text).replace(/\n/g, ' ').trim();
  return trimmed.length <= 40 ? trimmed : trimmed.slice(0, 40) + '…';
}

function register(registry) {
  registry.register(
    'edit_file',
    '精确替换项目文件中的某段文本（oldText→newText）。occurrence 指定第几次出现（1 起），缺省替换全部。' +
      '每次执行前请求用户确认，并自动备份 .bak。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        oldText: { type: 'string', description: '要查找的原文（必须精确匹配）' },
        newText: { type: 'string', description: '替换后的文本' },
        occurrence: { type: 'integer', description: '只替换第几次出现，缺省全部' },
      },
      required: ['path', 'oldText'],
    },
    async (context, args) => {
      const relative = String(args.path || '').trim();
      const oldText = String(args.oldText || '');
      const newText = String(args.newText || '');
      if (!relative) return AgentToolResult.error('缺少 path');
      if (!oldText) return AgentToolResult.error('缺少 oldText');
      const root = path.resolve(context.projectRoot());
      const file = resolveInRoot(root, relative);
      if (!file) return AgentToolResult.error('路径越过项目边界');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return AgentToolResult.error('文件不存在：' + relative);
      const occurrence = typeof args.occurrence === 'number' && Number.isFinite(args.occurrence) ? Math.floor(args.occurrence) : 0;
      try {
        const read = readTextFile(file);
        if (!read.ok) return AgentToolResult.error(read.error);
        const content = read.text;
        if (!content.includes(oldText)) return AgentToolResult.error('文件中未找到目标文本：' + abbreviate(oldText));
        let updated;
        let replaced;
        if (occurrence > 0) {
          const index = indexOfOccurrence(content, oldText, occurrence);
          if (index < 0) return AgentToolResult.error('目标文本第 ' + occurrence + ' 次出现不存在');
          updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
          replaced = 1;
        } else {
          updated = content.split(oldText).join(newText);
          replaced = countOccurrences(content, oldText);
        }
        const ok = await context.confirm(ConfirmationLevel.WRITE, '修改文件 ' + relative + '（替换 ' + replaced + ' 处）', '将把 ' + relative + ' 中的目标文本替换为 ' + abbreviate(newText) + '。');
        if (!ok) return AgentToolResult.error('已取消修改');
        fs.copyFileSync(file, file + '.bak');
        fs.writeFileSync(file, updated, 'utf-8');
        context.audit('edit_file ' + relative + ' replaced=' + replaced);
        context.notifyFileChange(relative, 'modify', '替换 ' + replaced + ' 处');
        return AgentToolResult.ok('已替换 ' + replaced + ' 处：' + relative, { path: relative, replaced });
      } catch (e) {
        return AgentToolResult.error('编辑失败：' + ((e && e.message) || e));
      }
    }
  );
}

module.exports = { register };
