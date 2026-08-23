/**
 * write_file：将内容写入项目内文件。路径校验 + 写前确认（WRITE 级，默认放行并记录）+ 可选备份 + 审计。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot } = require('./shared.cjs');

function register(registry) {
  registry.register(
    'write_file',
    '将内容写入项目内文件。每次执行前请求用户确认（项目内默认放行并记录）；backup=true（默认）覆盖前自动备份 .bak。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        content: { type: 'string', description: '要写入的内容' },
        backup: { type: 'boolean', description: '覆盖前是否备份，默认 true' },
      },
      required: ['path', 'content'],
    },
    async (context, args) => {
      const relative = String(args.path || '').trim();
      const content = String(args.content || '');
      if (!relative) return AgentToolResult.error('缺少 path');
      const root = path.resolve(context.projectRoot());
      const target = resolveInRoot(root, relative);
      if (!target) return AgentToolResult.error('路径越过项目边界');
      const existed = fs.existsSync(target);
      const what = '写入文件 ' + relative + (existed ? '（覆盖已有文件）' : '（新建文件）');
      const ok = await context.confirm(ConfirmationLevel.WRITE, what, '将 ' + content.length + ' 字节内容写入 ' + relative + '。');
      if (!ok) return AgentToolResult.error('已取消写入');
      const backup = args.backup !== false;
      try {
        if (existed && backup) {
          fs.copyFileSync(target, target + '.bak');
        }
        if (path.dirname(target)) fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf-8');
        context.audit('write_file ' + relative + ' bytes=' + content.length);
        context.notifyFileChange(relative, existed ? 'modify' : 'create', content.length + ' 字节');
        return AgentToolResult.ok('已写入 ' + relative + '（' + content.length + ' 字节）', { path: relative, bytes: content.length });
      } catch (e) {
        return AgentToolResult.error('写入失败：' + ((e && e.message) || e));
      }
    }
  );
}

module.exports = { register };
