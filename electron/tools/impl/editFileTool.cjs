/**
 * edit_file：精确替换项目文件中的某段文本（oldText→newText）。occurrence 指定第几次出现（1 起），缺省替换全部。
 * 修改前确认（WRITE 级），自动备份 .bak。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot, readTextFile, checkExpectedHash, sha256OfFile } = require('./shared.cjs');
const { atomicWriteFile } = require('../../atomicFile.cjs');

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
        expectedSha256: {
          type: 'string',
          description:
            '乐观并发（可选）：编辑前校验文件当前内容哈希必须等于它（可省 sha256: 前缀）；' +
            '不匹配则**不写**并返回 CONFLICT_STALE —— 并行 Agent 同时改一个文件时用它防静默覆盖。',
        },
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
      // 乐观并发：基于「我读到的那一版」改（校验在确认之前，注定失败的编辑不打扰用户）
      if (args.expectedSha256 != null && String(args.expectedSha256).trim()) {
        const guard = checkExpectedHash(file, args.expectedSha256);
        if (!guard.ok) {
          return AgentToolResult.failure(
            'CONFLICT_STALE',
            '编辑前校验失败（' + guard.reason + '）：' + relative + '。先重新读回最新内容，再基于它重做。',
            { path: relative, expected: String(args.expectedSha256), actual: guard.actual }
          );
        }
      }
      const occurrence = typeof args.occurrence === 'number' && Number.isFinite(args.occurrence) ? Math.floor(args.occurrence) : 0;
      try {
        const read = readTextFile(file);
        if (!read.ok) return AgentToolResult.error(read.error);
        const initial = /** @type {string} */ (read.text);
        // 确认前的这遍计算只为「注定失败的编辑别打扰用户」；真正写盘用的是确认后的重算结果
        if (!initial.includes(oldText)) return AgentToolResult.error('文件中未找到目标文本：' + abbreviate(oldText));
        const initialReplaced = occurrence > 0 ? (indexOfOccurrence(initial, oldText, occurrence) < 0 ? 0 : 1) : countOccurrences(initial, oldText);
        if (initialReplaced === 0) return AgentToolResult.error('目标文本第 ' + occurrence + ' 次出现不存在');
        const ok = await context.confirm(ConfirmationLevel.WRITE, '修改文件 ' + relative + '（替换 ' + initialReplaced + ' 处）', '将把 ' + relative + ' 中的目标文本替换为 ' + abbreviate(newText) + '。');
        if (!ok) return AgentToolResult.error('已取消修改');
        // #9：确认框可能挂很久，期间文件被外部改过。校验放在 confirm **之后**、写盘之前 ——
        // 这才是关掉 TOCTOU 窗口的那一次（确认前那次是「不打扰用户」，两次都要留）。
        if (args.expectedSha256 != null && String(args.expectedSha256).trim()) {
          const recheck = checkExpectedHash(file, args.expectedSha256);
          if (!recheck.ok) {
            return AgentToolResult.failure(
              'CONFLICT_STALE',
              '确认期间文件已被改动（' + recheck.reason + '）：' + relative + '。已放弃写入，请重新读回最新内容，基于它重做。',
              { path: relative, expected: String(args.expectedSha256), actual: recheck.actual }
            );
          }
        }
        // 写盘前重读并重算替换处数：确认框里的「替换 N 处」是确认前那一刻的快照，
        // 直接用旧快照写会把确认期间的外部改动一起覆盖掉。
        const fresh = readTextFile(file);
        if (!fresh.ok) return AgentToolResult.error(fresh.error);
        const content = /** @type {string} */ (fresh.text);
        if (!content.includes(oldText)) return AgentToolResult.error('确认期间文件已被改动，目标文本不存在了：' + relative);
        let updated;
        let replaced;
        if (occurrence > 0) {
          const index = indexOfOccurrence(content, oldText, occurrence);
          if (index < 0) return AgentToolResult.error('确认期间文件已被改动：目标文本第 ' + occurrence + ' 次出现不存在');
          updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
          replaced = 1;
        } else {
          updated = content.split(oldText).join(newText);
          replaced = countOccurrences(content, oldText);
        }
        fs.copyFileSync(file, file + '.bak');
        atomicWriteFile(file, updated, 'utf-8');
        context.audit('edit_file ' + relative + ' replaced=' + replaced);
        context.notifyFileChange(relative, 'modify', '替换 ' + replaced + ' 处');
        return AgentToolResult.ok('已替换 ' + replaced + ' 处：' + relative, {
          path: relative,
          replaced,
          // 回传写入后的哈希：下一个写者可以拿它当 expectedSha256（乐观并发的交接棒）
          sha256: sha256OfFile(file),
        });
      } catch (e) {
        return AgentToolResult.error('编辑失败：' + ((e && e.message) || e));
      }
    }
  );
}

module.exports = { register };
