'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../atomicFile.cjs');
const config = require('../../config/agent.backends.json');

function normalize(input) {
  if (!input || !config.backends.includes(input.backend)) throw new Error('未知 Agent 后端');
  if (!config.sandboxModes.includes(input.sandbox)) throw new Error('不支持的 Codex 工作目录权限');
  const executable = String(input.executable || '').trim();
  if (!executable || /[\r\n\0]/.test(executable)) throw new Error('请填写 codex 或可执行文件绝对路径');
  if (executable !== 'codex' && (!path.isAbsolute(executable) || !/\.exe$/i.test(executable) && process.platform === 'win32')) {
    throw new Error('Windows 自定义路径必须指向 Codex .exe；也可使用 codex 自动查找');
  }
  return { backend: input.backend, executable, model: String(input.model || '').trim().slice(0, 200), sandbox: input.sandbox };
}
function fileFor(root, userData, scope) {
  if (scope === 'project') {
    if (!root || !fs.statSync(root).isDirectory()) throw new Error('请先选择项目');
    return path.join(path.resolve(root), '.codenode', 'backend.json');
  }
  if (scope !== 'machine' || !userData) throw new Error('无效的设置范围');
  return path.join(path.resolve(userData), 'backend.json');
}
function readFile(file) {
  if (!fs.existsSync(file)) return null;
  return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function read(root, userData) {
  const machine = readFile(fileFor(null, userData, 'machine')) || { ...config.defaults };
  const project = root ? readFile(fileFor(root, userData, 'project')) : null;
  return { settings: project || machine, machine, project, scope: project ? 'project' : 'machine' };
}
function write(root, userData, scope, input) {
  const file = fileFor(root, userData, scope);
  for (const target of [path.dirname(file), file]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('设置路径不可为符号链接');
  }
  if (input === null && scope === 'project') {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else atomicWriteFile(file, JSON.stringify(normalize(input), null, 2) + '\n');
  return read(root, userData);
}
module.exports = { config, normalize, read, write };
