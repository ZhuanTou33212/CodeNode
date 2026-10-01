'use strict';

const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const memory = require('../../memory.cjs');
const { inferMemoryKind, memoryStatus } = require('../../memoryResolution.cjs');
const userMemory = require('../../userMemory.cjs');

function renderEntry(entry) {
  const state = memoryStatus(entry);
  const prefix = state === 'active' ? '' : '〔历史：' + state + '〕';
  return '- ' + prefix + (entry.key ? '[' + entry.key + (entry.value ? '=' + entry.value : '') + '] ' : '') + entry.content + ' [' + (entry.createdAt || '') + ']';
}

function register(registry) {
  registry.register('remember', '显式保存长期记忆。相同 scope + kind + key 是同一槽位，新值经确认后取代旧值；不填 key 则追加便笺。当前会话的临时要求不要调用 remember。', {
    type: 'object', properties: {
      content: { type: 'string' }, key: { type: 'string', description: '稳定槽位名，如 package_manager；同槽位的新内容会取代旧内容' },
      kind: { type: 'string', enum: ['note', 'preference', 'fact', 'decision'], description: '默认 note' },
      value: { type: 'string', description: '结构化当前值；偏好/配置建议填写，如 Python、pnpm' },
      validFrom: { type: 'string', description: '用户明确给出生效时间时填写；否则留空' },
      tags: { type: 'array', items: { type: 'string' } }, scope: { type: 'string', enum: ['project', 'user'] },
    }, required: ['content'],
  }, async (context, args) => {
    const content = String(args.content || '').trim();
    if (!content) return AgentToolResult.error('缺少 content');
    const scope = String(args.scope || 'project') === 'user' ? 'user' : 'project';
    const key = String(args.key || '').trim();
    const data = scope === 'user' ? userMemory.readUserMemory() : memory.readMemory(context.projectRoot());
    if (!data.ok) return AgentToolResult.error(data.error, { code: data.code, scope, file: data.file });
    const inferred = inferMemoryKind(data.entries, key, scope, args.kind);
    if (!inferred.ok) return AgentToolResult.error(inferred.error, { code: inferred.code, scope });
    const kind = inferred.kind;
    const prior = key ? memory.currentSlot(data.entries, { key, kind }, scope) : null;
    const previous = prior ? '将同槽位旧记忆「' + String(prior.content || '').slice(0, 160) + '」取代为：\n' : '';
    const valueDetail = args.value ? '结构化值：' + String(args.value).slice(0, 80) + '\n' : '';
    const ok = await context.confirm(ConfirmationLevel.WRITE,
      scope === 'user' ? '保存一条用户级（跨项目）长期记忆' : '保存一条项目长期记忆',
      (previous + valueDetail + content).slice(0, 400));
    if (!ok) return AgentToolResult.error('已取消保存记忆');
    const input = { key, kind, value: args.value, content, validFrom: args.validFrom,
      confirmedAt: new Date().toISOString(), tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
      source: 'remember_tool',
      sourceRef: (context.exec && context.exec.runId) || (typeof context.runId === 'function' ? context.runId() : context.runId) || '',
      sourceMessageId: (context.exec && context.exec.sourceMessageId) ||
        (typeof context.sourceMessageId === 'function' ? context.sourceMessageId() : context.sourceMessageId) || '' };
    const options = key ? { expectedRecordId: prior && prior.id || '' } : {};
    if (scope === 'user') {
      const added = userMemory.addUserMemory(input, options);
      if (!added.ok) return AgentToolResult.error('保存用户级记忆失败：' + (added.error || ''), { code: added.code, scope: 'user', file: added.file });
      context.audit('remember(user) ' + added.id + (added.duplicate ? ' duplicate' : '') +
        (added.replacedIds.length ? ' superseded=' + added.replacedIds.join(',') : ''));
      const evictionNote = added.evicted ? '\n用户级记忆超出上限，已淘汰最旧 ' + added.evicted + ' 条。' : '';
      return AgentToolResult.ok((added.duplicate ? '已有同样的用户级记忆：' : added.replacedIds.length ? '已更新用户级记忆：' : '已保存用户级记忆：') + content.slice(0, 120) + evictionNote,
        { id: added.id, scope: 'user', duplicate: !!added.duplicate, version: added.version,
          replacedIds: added.replacedIds, total: added.entries, evicted: added.evicted, evictedIds: added.evictedIds });
    }
    const added = memory.addProjectMemory(context.projectRoot(), input, options);
    if (!added.ok) return AgentToolResult.error('保存项目记忆失败：' + added.error, { code: added.code, scope: 'project', file: added.file });
    context.audit('remember ' + added.id + (added.duplicate ? ' duplicate' : '') + (added.replacedIds.length ? ' superseded=' + added.replacedIds.join(',') : ''));
    return AgentToolResult.ok((added.duplicate ? '已有同样的项目记忆：' : added.replacedIds.length ? '已更新项目记忆：' : '已保存长期记忆：') + content.slice(0, 120),
      { id: added.id, scope: 'project', duplicate: !!added.duplicate, version: added.version,
        replacedIds: added.replacedIds, total: added.total, evicted: added.evicted, evictedIds: added.evictedIds });
  });

  registry.register('recall', '搜索有效长期记忆：scope=project（默认）/user（跨项目）/all；includeHistory=true 可查看已取代的版本。', {
    type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' }, scope: { type: 'string', enum: ['project', 'user', 'all'] }, includeHistory: { type: 'boolean' } }, required: ['query'],
  }, async (context, args) => {
    const query = String(args.query || '').trim();
    if (!query) return AgentToolResult.error('缺少 query');
    const scope = ['user', 'all'].includes(String(args.scope || '')) ? String(args.scope) : 'project';
    const limit = Number(args.max) || 10;
    const includeHistory = args.includeHistory === true;
    if (scope === 'user' || scope === 'all') {
      const userData = userMemory.readUserMemory();
      if (!userData.ok) return AgentToolResult.error(userData.error, { code: userData.code, scope: 'user', file: userData.file });
      if (scope === 'user') {
        const pickedUser = memory.selectRelevant(userData.entries, query, { limit, scope: 'user', includeHistory });
        const lines = pickedUser.entries.map(renderEntry);
        if (!lines.length) return AgentToolResult.ok('没有匹配的用户级记忆', { entries: [], matched: false, scope });
        const fallbackNote = pickedUser.matched ? '' : '没有关键词匹配；以下是最近保存的记忆（未按查询检索）：\n';
        return AgentToolResult.ok('【用户级（跨项目）记忆】\n' + fallbackNote + lines.join('\n'),
          { entries: pickedUser.entries, matched: pickedUser.matched, scope });
      }
      const dataAll = memory.readMemory(context.projectRoot());
      if (!dataAll.ok) return AgentToolResult.error(dataAll.error, { code: dataAll.code, scope: 'project', file: dataAll.file });
      const projectActive = memory.resolveMemory(dataAll.entries, { scope: 'project' }).entries;
      const excludedSlots = includeHistory ? [] : projectActive.map(memory.memorySlot).filter(Boolean);
      const pickedUser = memory.selectRelevant(userData.entries, query, { limit, scope: 'user', includeHistory, excludedSlots });
      const pickedProject = memory.selectRelevant(dataAll.entries, query, { limit, scope: 'project', includeHistory });
      const anyMatched = pickedProject.matched || pickedUser.matched;
      const shownProject = anyMatched && !pickedProject.matched ? [] : pickedProject.entries;
      const shownUser = anyMatched && !pickedUser.matched ? [] : pickedUser.entries;
      const lines = shownUser.map(renderEntry);
      const projectLines = shownProject.map(renderEntry);
      if (!lines.length && !projectLines.length) return AgentToolResult.ok('没有匹配的长期记忆', { entries: [], matched: false, scope });
      const fallbackNote = anyMatched ? '' : '没有关键词匹配；以下是最近保存的记忆（未按查询检索）：\n';
      return AgentToolResult.ok(
        fallbackNote + '【项目记忆】\n' + (projectLines.join('\n') || '（无）') + '\n【用户级（跨项目）记忆】\n' + (lines.join('\n') || '（无）'),
        { entries: [...shownProject, ...shownUser], matched: anyMatched, scope },
      );
    }
    const data = memory.readMemory(context.projectRoot());
    if (!data.ok) return AgentToolResult.error(data.error, { code: data.code, scope: 'project', file: data.file });
    // 第 5 项：与 system prompt 的记忆注入共用同一套打分口径（memory.selectRelevant），
    // 避免「工具按关键词、注入按时间」两套语义给出不一样的结果。
    const picked = memory.selectRelevant(data.entries, query, { limit, scope: 'project', includeHistory });
    if (!picked.entries.length) {
      return AgentToolResult.ok('没有匹配的长期记忆', { entries: [], matched: false, terms: picked.terms });
    }
    // 一个词都没命中时，退回「最近保存的记忆」必须**显式说明**，否则模型会把它当成检索结果用
    const head = picked.matched ? '' : '没有关键词匹配；以下是最近保存的记忆（未按查询检索）：\n';
    return AgentToolResult.ok(
      head + picked.entries.map(renderEntry).join('\n'),
      { entries: picked.entries, matched: picked.matched, terms: picked.terms },
    );
  });
}

module.exports = { register };
