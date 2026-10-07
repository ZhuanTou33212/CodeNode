'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const ui = require('../config/ui.costs.json');
const roles = require('./tools/roles.cjs');
const PREFIX = 'agent.subagent.model.';
const GATE = 'agent.subagent.delegation_gate';
const REFERENCES = 'agent.repeat_result_references';
const BUDGET_PREFIX = 'agent.subagent.budget.';
function roleBudgets(input = {}) {
  const budgets = {};
  for (const role of roles.ROLE_NAMES) {
    budgets[role] = {};
    for (const [field, limit] of Object.entries(ui.budgetLimits)) {
      const value = input[role]?.[field] ?? ui.defaults.roleBudgets[role][field];
      if (!Number.isSafeInteger(value) || value < 0 || value > limit) throw new Error('角色预算必须是范围内的非负整数：' + role + '/' + field);
      budgets[role][field] = value;
    }
  }
  return budgets;
}

function parseSettings(properties = {}) {
  const roleModels = {};
  const inputBudgets = {};
  for (const role of roles.ROLE_NAMES) roleModels[role] = String(properties[PREFIX + role] || ui.defaults.roleModels[role] || '').trim();
  for (const role of roles.ROLE_NAMES) {
    inputBudgets[role] = {};
    for (const field of Object.keys(ui.budgetLimits)) {
      if (properties[BUDGET_PREFIX + role + '.' + field] != null) inputBudgets[role][field] = Number(properties[BUDGET_PREFIX + role + '.' + field]);
    }
  }
  return { delegationGate: properties[GATE] == null ? ui.defaults.delegationGate : String(properties[GATE]).toLowerCase() !== 'false',
    repeatResultReferences: properties[REFERENCES] == null ? ui.defaults.repeatResultReferences : String(properties[REFERENCES]).toLowerCase() !== 'false',
    roleModels, roleBudgets: roleBudgets(inputBudgets) };
}
function writeSettings(root, input, findModel) {
  if (!input || typeof input.delegationGate !== 'boolean' || !input.roleModels || typeof input.roleModels !== 'object') throw new Error('成本设置格式无效');
  const roleModels = {};
  if (input.repeatResultReferences != null && typeof input.repeatResultReferences !== 'boolean') throw new Error('重复结果引用选项必须是布尔值');
  const budgets = roleBudgets(input.roleBudgets);
  const repeatResultReferences = input.repeatResultReferences ?? ui.defaults.repeatResultReferences;
  for (const role of roles.ROLE_NAMES) {
    const id = input.roleModels[role];
    if (typeof id !== 'string' || id.length > 256 || /[\r\n\u0000=]/.test(id)) throw new Error('角色模型 ID 无效');
    roleModels[role] = id.trim();
    if (roleModels[role]) {
      const model = findModel(roleModels[role]);
      if (!model || model.enabled === false || model.apiKeyError) throw new Error('角色模型不可用，请重新选择已接入模型');
    }
  }
  const directory = path.join(path.resolve(root), '.codenode');
  const file = path.join(directory, 'agent.properties');
  for (const target of [directory, file]) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('设置路径不可为符号链接');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const managed = new Set([GATE, REFERENCES, ...roles.ROLE_NAMES.map(role => PREFIX + role),
    ...roles.ROLE_NAMES.flatMap(role => Object.keys(ui.budgetLimits).map(field => BUDGET_PREFIX + role + '.' + field))]);
  const lines = before.split(/\r?\n/).filter(line => !managed.has(line.split('=')[0].trim()));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(GATE + '=' + input.delegationGate);
  lines.push(REFERENCES + '=' + repeatResultReferences);
  for (const role of roles.ROLE_NAMES) if (roleModels[role]) lines.push(PREFIX + role + '=' + roleModels[role]);
  for (const role of roles.ROLE_NAMES) for (const [field, value] of Object.entries(budgets[role])) if (value) lines.push(BUDGET_PREFIX + role + '.' + field + '=' + value);
  atomicWriteFile(file, lines.join('\n') + '\n');
  return { delegationGate: input.delegationGate, repeatResultReferences, roleModels, roleBudgets: budgets };
}

function taskBudget(parent, subagent, role, args, settings) {
  const cap = roleBudgets(settings.roleBudgets)[role];
  const turns = Math.min(ui.budgetLimits.maxTurns, Number(parent.limits?.maxToolIterations) || 12, cap.maxTurns || Infinity);
  const tokens = Math.min(Number(subagent.maxTotalTokens) > 0 ? Number(subagent.maxTotalTokens) : Infinity, cap.tokenBudget || Infinity);
  return {
    maxTurns: Number.isInteger(args.maxTurns) && args.maxTurns > 0 ? Math.min(turns, args.maxTurns) : turns,
    tokenBudget: Number.isInteger(args.tokenBudget) && args.tokenBudget > 0 ? Math.min(ui.budgetLimits.tokenBudget, tokens, args.tokenBudget) : Number.isFinite(tokens) ? tokens : 0,
    maxOutputTokens: cap.maxOutputTokens,
  };
}
function applyOutputBudget(cfg, maxOutputTokens) {
  if (!(maxOutputTokens > 0)) return cfg;
  const maxTokens = Math.min(Number(cfg.maxTokens) || maxOutputTokens, maxOutputTokens);
  return { ...cfg, maxTokens, maxOutputTokensCap: Math.min(Number(cfg.maxOutputTokensCap) || maxTokens, maxTokens), limits: { ...cfg.limits,
    toolMaxTokens: Math.min(Number(cfg.limits?.toolMaxTokens) || maxTokens, maxTokens),
    finalMaxTokens: Math.min(Number(cfg.limits?.finalMaxTokens) || maxTokens, maxTokens) } };
}

// Only clearly bounded single operations are diverted. Independent verification,
// explicit stage tasks, dependencies and ambiguous objectives keep delegation.
function delegationDecision(args, settings) {
  if (!settings.delegationGate || args.stageNodeId || args.verifiesTaskId || args.dependsOnTaskIds?.length || ['verifier', 'reviewer', 'canvas'].includes(args.role)) return { delegate: true };
  const objective = String(args.objective || '').trim();
  if (args.taskSize === 'single_step') return { delegate: false, reason: 'single_step' };
  // Whole-objective matching avoids mistaking “read, then investigate” for one read.
  const read = /^(?:(?:请\s*)?(?:读取|阅读|打开)\s*|(?:read|open)\s+)(?:文件\s*)?[`"']?([^\s`"']+\.[a-z0-9]+)[`"']?[。.!]?$/i.exec(objective);
  if (read) return { delegate: false, reason: 'single_file_read' };
  return { delegate: true };
}

function connectionPrices(parent, model) {
  const prices = { ...parent.costPrices };
  delete prices[model.model];
  if (Number.isFinite(model.priceInput) && Number.isFinite(model.priceOutput) && model.priceInput >= 0 && model.priceOutput >= 0) {
    prices[model.model] = { in: model.priceInput, out: model.priceOutput,
      ...(Number.isFinite(model.priceInputHit) && model.priceInputHit >= 0 ? { cachedIn: model.priceInputHit } : {}) };
  }
  return prices;
}
function childConfig(parent, role, settings, findModel) {
  const taskType = 'subagent_' + role;
  const id = settings.roleModels[role];
  if (!id) return { ...parent, modelTaskType: taskType };
  const model = findModel(id);
  if (!model || model.enabled === false || model.apiKeyError) throw new Error('子 Agent 的角色模型不可用：' + role + '；请在成本与模型设置中重新选择');
  const cfg = { ...parent, model: model.model, apiBase: model.apiBase, apiKey: model.apiKey || '', modelTaskType: taskType, contextWindow: Number(model.contextWindow) || 0 };
  // A new connection owns every provider-specific option, even when it is blank.
  for (const field of ['protocol', 'auth', 'endpoint', 'apiVersion', 'azureDeployment', 'anthropicVersion', 'maxTokensField']) cfg[field] = model[field] || '';
  const local = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(String(cfg.apiBase));
  if (!cfg.apiKey && cfg.auth !== 'none' && !local) throw new Error('子 Agent 的角色模型尚未配置凭据：' + role);
  const caps = require('./modelEffort.cjs').capabilities(model);
  cfg.reasoningEffort = model.supportsEffort === false ? null : caps.effortLevels.includes(parent.reasoningEffort) ? parent.reasoningEffort : caps.defaultEffort;
  cfg.costPrices = connectionPrices(parent, model);
  // UI role selection takes priority over legacy role/generic routes; explicit
  // fallback candidates retain their existing credentials and shared budget.
  const routing = parent.modelRouting || { candidates: {}, routes: {}, fallbacks: [] };
  cfg.modelRouting = { ...routing, routes: { ...routing.routes } };
  delete cfg.modelRouting.routes[taskType]; delete cfg.modelRouting.routes.subagent;
  return cfg;
}
module.exports = { parseSettings, writeSettings, delegationDecision, childConfig, connectionPrices, taskBudget, applyOutputBudget };
