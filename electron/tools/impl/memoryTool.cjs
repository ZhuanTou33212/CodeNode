'use strict';

const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { readMemory, writeMemory } = require('../../memory.cjs');

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

  registry.register('recall', '搜索项目长期记忆，返回与 query 匹配的决策、约定和偏好。', {
    type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' } }, required: ['query'],
  }, async (context, args) => {
    const query = String(args.query || '').trim().toLowerCase();
    if (!query) return AgentToolResult.error('缺少 query');
    const terms = query.split(/\s+/).filter(Boolean);
    const data = readMemory(context.projectRoot());
    const entries = data.entries.filter((entry) => terms.every((term) => JSON.stringify(entry).toLowerCase().includes(term))).slice(-(Number(args.max) || 10));
    return AgentToolResult.ok(entries.length ? entries.map((entry) => `- ${entry.content} [${entry.createdAt}]`).join('\n') : '没有匹配的长期记忆', { entries });
  });
}

module.exports = { register };
