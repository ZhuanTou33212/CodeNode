'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const ui = require('../config/ui.agent.json');
function parseAutoExecution(properties = {}) {
  return properties['tools.confirm_writes'] == null ? ui.defaults.autoExecuteTools
    : String(properties['tools.confirm_writes']).trim().toLowerCase() === 'false';
}
function canAutoExecute(name, args = {}) {
  if (!ui.ordinaryWriteTools.includes(name)) return false;
  if (name !== 'workbench_edit') return true;
  const operations = Array.isArray(args.operations) && args.operations.length ? args.operations : [args];
  return operations.every(operation => operation && ui.ordinaryCanvasActions.includes(String(operation.action || 'create').toLowerCase()));
}
function writeSettings(root, input) {
  if (!input || typeof input.autoExecuteTools !== 'boolean') throw new Error('普通工具自动执行选项必须是布尔值');
  const directory = path.join(path.resolve(root), '.codenode');
  const file = path.join(directory, 'agent.properties');
  for (const target of [directory, file]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('设置路径不可为符号链接');
  }
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = before.split(/\r?\n/).filter(line => !/^\s*tools\.confirm_writes\s*=/.test(line));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push('tools.confirm_writes=' + String(!input.autoExecuteTools));
  atomicWriteFile(file, lines.join('\n') + '\n');
  return { autoExecuteTools: input.autoExecuteTools };
}
module.exports = { parseAutoExecution, canAutoExecute, writeSettings };
