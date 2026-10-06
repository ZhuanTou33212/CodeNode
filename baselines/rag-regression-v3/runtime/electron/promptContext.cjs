/**
 * promptContext.cjs —— 桌面与命令行共用动态 system prompt 上下文预算。
 *
 * 记忆、技能索引与画布摘要必须走同一份预算实现，避免 headless 入口绕过
 * Electron 界面已使用的命中筛选、段落上限与按需读取。
 */
'use strict';

const memoryStore = require('./memory.cjs');
const compaction = require('./compaction.cjs');
const dynamicContext = require('./dynamicContextBudget.cjs');
const { extractSessionMemoryOverrides } = require('./sessionMemoryOverrides.cjs');

/**
 * @param {{
 *   prompt?: string, canvasSummary?: string, projectMemoryEntries?: any[], skills?: any[],
 *   sessionOverrides?: Array<{scope?: string, kind?: string, key: string, value?: string}>,
 *   memoryIntent?: {changes?: Array<any>, overrides?: Array<any>, persistentCandidates?: Array<any>} | null,
 *   memoryConfig?: any, dynamicContextConfig?: any, userMemoryStore?: any,
 *   buildSkillsIndex: (skills: any[]) => string,
 *   truncateCanvasSummary: (text: string, budget: number) => {text: string},
 *   truncateSkillsIndex: (text: string, budget: number) => {text: string}
 * }} input
 */
function buildPromptContext(input) {
  const i = input;
  const prompt = String(i.prompt || '');
  const memoryCfg = i.memoryConfig || {};
  const dynCfg = i.dynamicContextConfig || dynamicContext.parseDynamicContextConfig({});
  const userStore = i.userMemoryStore || require('./userMemory.cjs');
  const skillsIndexFull = i.buildSkillsIndex(Array.isArray(i.skills) ? i.skills : []);
  const projectEntries = Array.isArray(i.projectMemoryEntries) ? i.projectMemoryEntries : [];
  const userData = typeof userStore.readUserMemory === 'function' ? userStore.readUserMemory() : { entries: [] };
  const overrideContext = /** @type {{changes?: Array<any>, overrides?: Array<any>, persistentCandidates?: Array<any>}} */ (i.memoryIntent || extractSessionMemoryOverrides(prompt, {
    projectEntries,
    userEntries: userData && userData.ok !== false ? userData.entries : [],
  }));
  const turnOverrides = Array.isArray(overrideContext.changes)
    ? overrideContext.changes.filter((item) => item && ['temporary', 'permanent'].includes(item.action)).map((item) => item.override)
    : (Array.isArray(overrideContext.overrides) ? overrideContext.overrides : []);
  const overrideSlots = new Map();
  for (const item of [...(Array.isArray(i.sessionOverrides) ? i.sessionOverrides : []), ...turnOverrides]) {
    const slot = memoryStore.memorySlot(item);
    if (slot) overrideSlots.set(slot, item);
  }
  const sessionOverrides = [...overrideSlots.values()];
  const sessionMemoryText = sessionOverrides.length || (overrideContext.persistentCandidates || []).length
    ? JSON.stringify({ overrides: sessionOverrides.map((item) => ({
      scope: item.scope, kind: item.kind, key: item.key, value: item.value, lifetime: item.lifetime || 'task',
    })), persistentCandidates: overrideContext.persistentCandidates || [] })
      .replace(/[<>&]/g, (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char])
    : '';
  // 在召回打分前先取每个槽位的有效版本；项目槽位覆盖同名用户级默认值。
  const projectResolved = memoryStore.resolveMemory(projectEntries, {
    scope: 'project', sessionOverrides,
  });
  const projectSlots = projectResolved.entries.map(memoryStore.memorySlot).filter(Boolean);

  const dynMemoryCap = dynCfg.sections.find((s) => s.id === 'memory')
    ? dynCfg.sections.find((s) => s.id === 'memory').capTokens
    : memoryCfg.budgetTokens;
  const memoryCap = Math.min(
    Math.max(0, Number(memoryCfg.budgetTokens) || 0),
    Math.max(0, Number(dynMemoryCap) || 0),
  );
  const sessionMemoryTokens = compaction.estimateTextTokens(sessionMemoryText);
  const storedMemoryCap = Math.max(0, memoryCap - sessionMemoryTokens);
  const measureProject = memoryStore.buildMemoryInjection(projectResolved.entries, prompt, {
    limit: memoryCfg.topK,
    maxEntryChars: memoryCfg.maxEntryChars,
    budgetTokens: storedMemoryCap,
    requireMatch: memoryCfg.requireMatch,
    label: '此项目',
    scope: 'project',
    sessionOverrides,
  });
  const measureUser = userStore.buildUserMemoryInjection(prompt, {
    limit: memoryCfg.userTopK,
    maxEntryChars: memoryCfg.maxEntryChars,
    budgetTokens: Math.max(0, storedMemoryCap - measureProject.tokens),
    requireMatch: memoryCfg.requireMatch,
    label: '用户级（跨项目）记忆',
    excludedSlots: projectSlots,
    sessionOverrides,
  });

  const canvasSummary = String(i.canvasSummary == null ? '' : i.canvasSummary);
  const contextBudget = dynCfg.totalTokens > 0
    ? dynamicContext.allocateContextBudget({
        totalTokens: dynCfg.totalTokens,
        sections: [
          {
            id: 'canvas',
            desiredTokens: compaction.estimateTextTokens(canvasSummary),
            capTokens: dynCfg.sections.find((s) => s.id === 'canvas')?.capTokens,
          },
          {
            id: 'memory',
            desiredTokens: sessionMemoryTokens + measureProject.tokens + measureUser.tokens,
            capTokens: dynCfg.sections.find((s) => s.id === 'memory')?.capTokens,
            minTokens: sessionMemoryTokens,
          },
          {
            id: 'skills',
            desiredTokens: compaction.estimateTextTokens(skillsIndexFull),
            capTokens: dynCfg.sections.find((s) => s.id === 'skills')?.capTokens,
          },
        ],
      })
    : null;

  let memoryText = measureProject.text;
  let userMemoryText = measureUser.text;
  let skillsText = skillsIndexFull;
  let canvasSummaryForPrompt = canvasSummary;
  if (contextBudget) {
    const grantOf = (id) => {
      const row = contextBudget.trace.find((t) => t.id === id);
      return row ? Number(row.granted) || 0 : 0;
    };
    const trimOf = (id) => {
      const row = contextBudget.trace.find((t) => t.id === id);
      return !row || row.reason === 'full' || row.reason === 'empty' ? null : row;
    };

    const memoryCapGranted = Math.max(0, grantOf('memory') - sessionMemoryTokens);
    if (trimOf('memory') && memoryCapGranted !== storedMemoryCap) {
      const rebuiltProject = memoryStore.buildMemoryInjection(projectResolved.entries, prompt, {
        limit: memoryCfg.topK,
        maxEntryChars: memoryCfg.maxEntryChars,
        budgetTokens: memoryCapGranted,
        requireMatch: memoryCfg.requireMatch,
        label: '此项目',
        scope: 'project',
        sessionOverrides,
      });
      const rebuiltUser = userStore.buildUserMemoryInjection(prompt, {
        limit: memoryCfg.userTopK,
        maxEntryChars: memoryCfg.maxEntryChars,
        budgetTokens: Math.max(0, memoryCapGranted - rebuiltProject.tokens),
        requireMatch: memoryCfg.requireMatch,
        label: '用户级（跨项目）记忆',
        excludedSlots: projectSlots,
        sessionOverrides,
      });
      memoryText = rebuiltProject.text;
      userMemoryText = rebuiltUser.text;
    }
    if (trimOf('canvas')) {
      canvasSummaryForPrompt = i.truncateCanvasSummary(canvasSummary, grantOf('canvas')).text;
    }
    if (trimOf('skills')) {
      skillsText = i.truncateSkillsIndex(skillsIndexFull, grantOf('skills')).text;
    }
  }

  return {
    memoryText,
    userMemoryText,
    skillsText,
    canvasSummaryForPrompt,
    contextBudget,
    sessionMemoryText,
    sessionOverrides,
  };
}

module.exports = { buildPromptContext };
