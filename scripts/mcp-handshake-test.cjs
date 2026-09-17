/**
 * mcp-handshake-test.cjs —— MCP 适配的握手与命令解析（任务单第 7 项）的回归用例
 *
 * 缺陷（探针 out/mcp-session-probe.cjs 实测）：
 *   ① 客户端把 initialize / notifications/initialized / tools/call **一次性发出去**，只等 id=2 的应答 ——
 *      server 对 initialize 完全不回应时，工具调用**照样成功**（握手结果从未被校验）；
 *   ② `command` 里含空格的路径若没加引号，被 splitCommand 按空格拆坏 → `spawn C:\Program ENOENT`，
 *      错误信息完全指不到「加引号」这个修法。
 *
 * 修复：先握手（等 id=1 的应答，超时/error 分别如实报）再发 notifications/initialized + tools/call；
 * 整段 command 就是存在的可执行文件时不再按空格拆；spawn ENOENT + 含空格时补「请加引号」提示。
 *
 * 判据：① 不回握手 → **必须失败**且错误指向握手（回归锁住旧行为）；② 正常握手 → 调用成功；
 * ③ initialize 返回 error → 透出 server 的错误；④ 含空格路径不加引号也能跑通（整段当路径）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

/** Windows 上 rmSync(recursive) 对含空格/长路径会 EPERM → 逐项删（既有用例同款做法） */
function cleanup(dir) {
  const walk = (target) => {
    let items = [];
    try { items = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(target, item.name);
      if (item.isDirectory()) walk(full);
      else try { fs.unlinkSync(full); } catch {}
    }
    try { fs.rmdirSync(target); } catch {}
  };
  walk(dir);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-mcp-handshake-'));
const STUB = path.join(root, 'mcp-stub.cjs');
// 替身 server：--mode=normal|no-init-reply|init-error
fs.writeFileSync(STUB, `'use strict';
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=normal').slice('--mode='.length);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      if (mode === 'no-init-reply') continue;
      if (mode === 'init-error') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad protocol version' } }) + '\\n'); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '1' } } }) + '\\n');
      continue;
    }
    if (msg.method === 'notifications/initialized') continue;
    if (msg.method === 'tools/call') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'stub ok' }] } }) + '\\n'); continue; }
  }
});
process.stdin.on('end', () => process.exit(0));
`, 'utf8');

function makeProject(command, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(root, 'proj-'));
  fs.mkdirSync(path.join(dir, '.codenode'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codenode', 'extensions.json'), JSON.stringify([
    {
      name: 'stubmcp',
      kind: 'mcp',
      description: '握手用例替身',
      command,
      args: [STUB, '--mode=' + (globalThis.__mcpMode || 'normal')],
      timeoutMs: timeoutMs || 1500,
      tools: [{ name: 'stub_echo', description: '回显', parameters: { type: 'object', properties: {} } }],
    },
  ], null, 2), 'utf8');
  return dir;
}

async function callTool(mode, command, timeoutMs) {
  globalThis.__mcpMode = mode;
  const projectRoot = makeProject(command, timeoutMs);
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot, userDataDir: projectRoot });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot, ragEnabled: false });
  const context = new AgentToolContext({
    projectRoot,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
  const res = await registry.execute('stub_echo', {}, context);
  return res;
}

(async () => {
  const quoted = '"' + process.execPath + '"';

  const normal = await callTool('normal', quoted);
  check('① 正常握手 → 调用成功（回归：修复不能把正常 MCP 打坏）',
    normal.ok === true && String(normal.text).includes('stub ok'), String(normal.text).slice(0, 60));

  const noInit = await callTool('no-init-reply', quoted, 1200);
  check('② server 不回 initialize → 必须失败，且错误指向「握手」（不再静默成功）',
    noInit.ok === false && /握手/.test(String(noInit.text)), String(noInit.text).slice(0, 80));

  const initError = await callTool('init-error', quoted);
  check('③ initialize 返回 error → 透出 server 的错误（不再当成 tools/call 的问题）',
    initError.ok === false && /握手失败/.test(String(initError.text)) && /bad protocol version/.test(String(initError.text)), String(initError.text).slice(0, 90));

  // ④ 含空格的路径不加引号：整段就是存在的可执行文件 → 直接当路径用
  const unquoted = await callTool('normal', process.execPath);
  check('④ 含空格的 node 路径不加引号也能跑通（旧实现会被拆成 "C:\\Program" 报 ENOENT）',
    process.execPath.includes(' ') ? unquoted.ok === true : true,
    'execPath=' + process.execPath + ' text=' + String(unquoted.text).slice(0, 60));

  // ⑤ 真正不存在的含空格命令 → 错误里必须出现「引号」提示
  const broken = await callTool('normal', path.join(root, 'no such dir', 'nope.exe'));
  check('⑤ 不存在的含空格命令 → 报错补上「请加引号」的修法提示',
    broken.ok === false && /引号/.test(String(broken.text)), String(broken.text).slice(0, 100));

  cleanup(root);
  console.log('MCP HANDSHAKE TEST: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('MCP HANDSHAKE TEST: ERROR', error);
  process.exit(1);
});
