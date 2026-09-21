'use strict';

const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { readMemory, writeMemory, selectRelevant } = require('../../memory.cjs');
const userMemory = require('../../userMemory.cjs');

function register(registry) {
  registry.register('remember', '保存长期记忆：scope=project（默认）写项目 .codenode/memory.json；scope=user 写用户级跨项目记忆（~/.codenode/user-memory.json，适合「我用 pnpm」「署名用 X」这类与仓库无关的偏好）。', {
    type: 'object', properties: { content: { type: 'string' }, key: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, scope: { type: 'string', enum: ['project', 'user'] } }, required: ['content'],
  }, async (context, args) => {
    const content = String(args.content || '').trim();
    if (!content) return AgentToolResult.error('缺少 content');
    const scope = String(args.scope || 'project') === 'user' ? 'user' : 'project';
    const ok = await context.confirm(ConfirmationLevel.WRITE, scope === 'user' ? '保存一条用户级（跨项目）长期记忆' : '保存一条项目长期记忆', content.slice(0, 240));
    if (!ok) return AgentToolResult.error('已取消保存记忆');
    if (scope === 'user') {
      const added = userMemory.addUserMemory({ key: String(args.key || ''), content, tags: Array.isArray(args.tags) ? args.tags.map(String) : [] });
      if (!added.ok) return AgentToolResult.error('保存用户级记忆失败：' + (added.error || ''));
      context.audit('remember(user) ' + added.id + (added.duplicate ? ' duplicate' : ''));
      return AgentToolResult.ok((added.duplicate ? '已有同样的用户级记忆：' : '已保存用户级记忆：') + content.slice(0, 120), { id: added.id, scope: 'user', duplicate: !!added.duplicate, total: added.entries });
    }
    const data = readMemory(context.projectRoot());
    const entry = { id: 'mem-' + Date.now().toString(36), key: String(args.key || ''), content, tags: Array.isArray(args.tags) ? args.tags.map(String) : [], createdAt: new Date().toISOString() };
    writeMemory(context.projectRoot(), [...data.entries, entry]);
    context.audit('remember ' + entry.id);
    return AgentToolResult.ok('已保存长期记忆：' + content.slice(0, 120), { id: entry.id, scope: 'project' });
  });

  registry.register('recall', '搜索长期记忆：scope=project（默认）/user（跨项目）/all。按 key/tags/内容打分，不只按时间。', {
    type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' }, scope: { type: 'string', enum: ['project', 'user', 'all'] } }, required: ['query'],
  }, async (context, args) => {
    const query = String(args.query || '').trim();
    if (!query) return AgentToolResult.error('缺少 query');
    const scope = ['user', 'all'].includes(String(args.scope || '')) ? String(args.scope) : 'project';
    const limit = Number(args.max) || 10;
    if (scope === 'user' || scope === 'all') {
      const pickedUser = userMemory.selectRelevant(userMemory.readUserMemory().entries, query, { limit });
      const lines = pickedUser.entries.map((entry) => `- ${entry.key ? '[' + entry.key + '] ' : ''}${entry.content} [${entry.createdAt}]`);
      if (scope === 'user') {
        if (!lines.length) return AgentToolResult.ok('没有匹配的用户级记忆', { entries: [], matched: false, scope });
        return AgentToolResult.ok('【用户级（跨项目）记忆】\n' + lines.join('\n'), { entries: pickedUser.entries, matched: pickedUser.matched, scope });
      }
      const dataAll = readMemory(context.projectRoot());
      const pickedProject = selectRelevant(dataAll.entries, query, { limit });
      const projectLines = pickedProject.entries.map((entry) => `- ${entry.key ? '[' + entry.key + '] ' : ''}${entry.content} [${entry.createdAt}]`);
      if (!lines.length && !projectLines.length) return AgentToolResult.ok('没有匹配的长期记忆', { entries: [], matched: false, scope });
      return AgentToolResult.ok(
        '【项目记忆】\n' + (projectLines.join('\n') || '（无）') + '\n【用户级（跨项目）记忆】\n' + (lines.join('\n') || '（无）'),
        { entries: [...pickedProject.entries, ...pickedUser.entries], matched: pickedProject.matched || pickedUser.matched, scope },
      );
    }
    const data = readMemory(context.projectRoot());
    // 第 5 项：与 system prompt 的记忆注入共用同一套打分口径（memory.selectRelevant），
    // 避免「工具按关键词、注入按时间」两套语义给出不一样的结果。
    const picked = selectRelevant(data.entries, query, { limit: Number(args.max) || 10 });
    if (!picked.entries.length) {
      return AgentToolResult.ok('没有匹配的长期记忆', { entries: [], matched: false, terms: picked.terms });
    }
    // 一个词都没命中时，退回「最近保存的记忆」必须**显式说明**，否则模型会把它当成检索结果用
    const head = picked.matched ? '' : '没有关键词匹配；以下是最近保存的记忆（未按查询检索）：\n';
    return AgentToolResult.ok(
      head + picked.entries.map((entry) => `- ${entry.content} [${entry.createdAt}]`).join('\n'),
      { entries: picked.entries, matched: picked.matched, terms: picked.terms },
    );
  });
}

module.exports = { register };
