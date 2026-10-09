'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../atomicFile.cjs');
const config = require('../../config/agent.backends.json');

function normalize(input) {
  if (!input || !config.backends.includes(input.backend)) throw new Error('未知 Agent 后端');
  if (!config.sandboxModes.includes(input.sandbox)) throw new Error('不支持的 Codex 工作目录权限');
  let executable = String(input.executable || config.commands[input.backend] || '').trim();
  // Migrate only known legacy defaults. Custom commands remain explicit user configuration.
  if(input.backend==='codex' && (executable==='codex'||(input.settingsVersion!==2&&/^codex(?:\.exe)?$/i.test(executable.split(/[\\/]/).pop()||'')))) executable=config.commands.codex;
  if (input.backend !== 'builtin' && (!executable || /[\r\n\0]/.test(executable))) throw new Error('请填写可执行命令或绝对路径');
  if (path.isAbsolute(executable) && process.platform === 'win32' && !/\.(?:exe|mjs|js|py)$/i.test(executable)) throw new Error('Windows 自定义程序路径格式不受支持');
  let args = Array.isArray(input.args) ? input.args.slice() : config.defaultArgs[input.backend] || [];
  if(input.backend==='codex' && args[0]==='app-server') args=[];
  if(input.backend==='deepseek-harness'&&input.settingsVersion!==2&&!args.length)args=config.defaultArgs['deepseek-harness'].slice();
  if(input.backend==='deepseek-harness') args=args.map((arg,index)=>index>0&&args[index-1]==='--profile'&&arg==='sdk'?'acp':arg);
  if (args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\0]/.test(arg))) throw new Error('启动参数无效');
  if (args.some(arg => /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)(?:=|$)/i.test(arg))) {
    throw new Error('启动参数不能保存明文密钥或口令；请使用 Agent 自身的凭据配置或安全文件选项');
  }
  return { transport:input.backend==='builtin'?'builtin':'acp', settingsVersion:2, backend: input.backend, executable, args: args.slice(), model: String(input.model || '').trim().slice(0, 200),
    provider: String(input.provider || config.defaults.provider).trim().slice(0, 100), home: String(input.home || '').trim().slice(0, 2048), sandbox: input.sandbox,
    reasoningEffort: String(input.reasoningEffort || '').trim().slice(0, 40), ...(input.acp ? { acp: normalizeAcp(input.acp) } : {}) };
}
function normalizeAcp(input) {
  if (!input || typeof input !== 'object') throw new Error('ACP 设置无效');
  const configValues = input.configValues || {};
  if (typeof configValues !== 'object' || Array.isArray(configValues) || Object.entries(configValues).some(([key, value]) => key.length > 200 || !['string', 'boolean'].includes(typeof value) || String(value).length > 1000)) throw new Error('ACP 配置值必须是字符串或布尔值');
  const servers = input.mcpServers || [];
  if (!Array.isArray(servers) || servers.length > 16 || Buffer.byteLength(JSON.stringify(servers)) > 65536) throw new Error('ACP MCP 服务器设置无效');
  const mcpServers = servers.map(server => {
    if (!server || typeof server.name !== 'string' || !server.name.trim() || server.name === 'codenode') throw new Error('MCP 名称无效或使用保留名称');
    if (server.type === 'http' || server.type === 'sse') {
      if (typeof server.url !== 'string' || !/^https?:\/\//i.test(server.url) || new URL(server.url).username || new URL(server.url).password) throw new Error('MCP URL 无效');
      if (server.headers?.length) throw new Error('MCP 凭据请保存在 Agent 自身配置中');
      return { name: server.name, type: server.type, url: server.url, headers: [] };
    }
    if (server.type != null || typeof server.command !== 'string' || !server.command || /[\0\r\n]/.test(server.command) || !Array.isArray(server.args) || server.args.some(x => typeof x !== 'string' || x.includes('\0') || /^--?(?:token|password|secret|api[-_]?key)(?:=|$)/i.test(x))) throw new Error('MCP stdio 命令无效');
    if (server.env?.length) throw new Error('MCP 环境凭据请保存在 Agent 自身配置中');
    return { name: server.name, command: server.command, args: server.args, env: [] };
  });
  if (new Set(mcpServers.map(x => x.name)).size !== mcpServers.length) throw new Error('MCP 名称重复');
  return { authMethodId: String(input.authMethodId || '').slice(0, 200), modeId: String(input.modeId || '').slice(0, 200), configValues, mcpServers, codeNodeTools: input.codeNodeTools === true };
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
function readProfiles(file) {
  if(!fs.existsSync(file))return {};
  const value=JSON.parse(fs.readFileSync(file,'utf8')),out={};
  for(const name of config.backends){const entry=value.profiles?.[name];if(entry?.backend===name)out[name]=normalize(entry);}
  const selected=normalize(value);out[selected.backend]=selected;return out;
}
function read(root, userData) {
  const machine = readFile(fileFor(null, userData, 'machine')) || { ...config.defaults };
  const project = root ? readFile(fileFor(root, userData, 'project')) : null;
  return { settings: project || machine, machine, project, profiles:{...readProfiles(fileFor(null,userData,'machine')),...(root?readProfiles(fileFor(root,userData,'project')):{})}, scope: project ? 'project' : 'machine' };
}
function write(root, userData, scope, input) {
  const file = fileFor(root, userData, scope);
  for (const target of [path.dirname(file), file]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('设置路径不可为符号链接');
  }
  if (input === null && scope === 'project') {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else {const selected=normalize(input);const profiles={...readProfiles(file),[selected.backend]:selected};atomicWriteFile(file,JSON.stringify({...selected,profiles},null,2)+'\n');}
  return read(root, userData);
}
module.exports = { config, normalize, read, write };
