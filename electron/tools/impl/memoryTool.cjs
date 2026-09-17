'use strict';

const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { readMemory, writeMemory, selectRelevant } = require('../../memory.cjs');

function register(registry) {
  registry.register('remember', '保存项目长期记忆（决策、约定、用户偏好），写入项目 .codenode/memory.json。', {
    type: 'object', properties: { content: { type: 'string' }, key: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['content'],
  }, async (context, args) => {
    const content = String(args.content || '').trim();
    if (!content) return AgentToolResult.error('缺少 content');
    const ok = await context.confirm(ConfirmationLevel.WRITE, '保存一条项目长期记忆', content.slice(0, 240));
    if (!ok) return AgentToolResult.error('已取消保存记忆');
    const data = readMemory(context.projectRoot());
    const entry = { id: 'mem-' + Date.now().toString(36), key: String(args.key || ''), content, tags: Array.isArray(args.tags) ? args.tags.map(String) : [], createdAt: new Date().toISOString() };
    writeMemory(context.projectRoot(), [...data.entries, entry]);
    context.audit('remember ' + entry.id);
    return AgentToolResult.ok('已保存长期记忆：' + content.slice(0, 120), { id: entry.id });
  });

  registry.register('recall', '搜索项目长期记忆，返回与 query 匹配的决策、约定和偏好（按 key/tags/内容打分，不只按时间）。', {
    type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' } }, required: ['query'],
  }, async (context, args) => {
    const query = String(args.query || '').trim();
    if (!query) return AgentToolResult.error('缺少 query');
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
