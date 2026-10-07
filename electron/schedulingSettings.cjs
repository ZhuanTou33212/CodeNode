'use strict';
const fs = require('fs');
const path = require('path');
const ui = require('../config/ui.scheduling.json');
const { userHome } = require('./userMemory.cjs');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { withFileLock } = require('./fileLock.cjs');

const KEYS = {
  concurrency: 'agent.scheduling.concurrency',
  maxTasksPerRun: 'agent.subagent.max_tasks_per_run',
  maxBatchTasks: 'agent.subagent.max_batch_tasks',
  warningPercent: 'agent.subagent.warning_percent',
};
const BUDGET_NOTE_PREFIX = '【系统提示】子任务配额预警：';

function parseSettings(properties = {}) {
  const settings = { ...ui.defaults };
  for (const field of Object.keys(KEYS)) {
    const raw = properties[KEYS[field]] ?? (field === 'concurrency' ? properties['agent.subagent.max_concurrent_tasks'] : undefined);
    const value = Number(raw);
    const bounds = ui.limits[field];
    if (raw != null && String(raw).trim() && Number.isInteger(value)) settings[field] = Math.max(bounds.min, Math.min(bounds.max, value));
  }
  return settings;
}

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('调度设置格式无效');
  const settings = { ...ui.defaults };
  for (const field of Object.keys(settings)) {
    const value = input[field];
    const bounds = ui.limits[field];
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) throw new Error(field + ' 必须是 ' + bounds.min + '–' + bounds.max + ' 之间的整数');
    settings[field] = value;
  }
  return settings;
}

function settingsFile() { return path.join(userHome(), 'agent-scheduling.json'); }
function checkPath(file) {
  for (const target of [path.dirname(file), file, file + '.lock']) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('调度设置路径不可为符号链接');
  }
}
function readSettings(properties = {}) {
  const file = settingsFile();
  checkPath(file);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1) throw new Error('调度设置版本无效');
    return validateSettings(saved.settings);
  } catch (error) {
    if (error && error.code === 'ENOENT') return parseSettings(properties);
    throw new Error('全局调度设置无法读取，请先修复原文件：' + String(error && error.message || error));
  }
}
function writeSettings(input) {
  const settings = validateSettings(input);
  const file = settingsFile();
  checkPath(file);
  return withFileLock(file, () => {
    readSettings(); // A corrupt existing file must not be silently overwritten.
    atomicWriteFile(file, JSON.stringify({ version: 1, settings }, null, 2) + '\n');
    return settings;
  });
}

function budgetState(used, limit, warningPercent = ui.defaults.warningPercent) {
  const remaining = Math.max(0, limit - used);
  return { used, limit, remaining, warningPercent, warningAt: Math.ceil(limit * warningPercent / 100),
    warning: used >= Math.ceil(limit * warningPercent / 100), exhausted: remaining === 0 };
}
function updateBudgetNote(messages, state) {
  // Replace the machine-owned note after compaction, including restored runs.
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user' && typeof messages[index].content === 'string' && messages[index].content.startsWith(BUDGET_NOTE_PREFIX)) messages.splice(index, 1);
  }
  if (!state?.warning) return;
  messages.push({ role: 'user', content: BUDGET_NOTE_PREFIX + '已启动 ' + state.used + '/' + state.limit + ' 个子任务，剩余 ' + state.remaining + ' 个；预警阈值 ' + state.warningPercent + '%。\n' +
    (state.exhausted ? '子任务额度已用尽，不再调用 delegate_task/delegate_tasks。' : '请收敛计划，避免扩张或原样重复委派，优先将剩余额度用于必要验证与审查。') +
    '汇总已完成、未完成和阻塞项；有能力时由主 Agent 直接完成余下步骤，不得把未完成或未验证的工作表述为完成。失败或启动后取消的任务仍计入额度；本提示不增加额度，也不绕过验收、审批或成本限制。' });
}
module.exports = { parseSettings, readSettings, writeSettings, validateSettings, settingsFile, budgetState, updateBudgetNote, BUDGET_NOTE_PREFIX };
