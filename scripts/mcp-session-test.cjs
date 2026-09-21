/**
 * mcp-session-test.cjs —— MCP 会话复用 + `tools/list` 缓存（对照文档 §5 #5）
 *
 * 短板：此前每调一次 MCP 工具就 spawn 一个新 server、握手一次、跑完杀掉，且从不发 `tools/list`。
 *
 * 判据（用真实 stdio 往返 + server 侧的请求日志取证，不看实现自我报告）：
 *   A 会话复用：连续两次工具调用 → server 只被 spawn **一次**、initialize 只做一次、tools/list 只问一次
 *   B tools/list 缓存：清单里声明了 echo/crash；调用未声明的工具 → 调用本身仍照做（不擅自当权限门），
 *     但结果里如实标注「server 的清单里没有它，可用的是……」——既不静默、也不越权拦截
 *   C 崩溃语义：server 进程自杀 → 这次调用如实报错；下一次调用重新拉起（spawn 计数 +1）
 *   D 空闲回收：idleMs 到点关闭会话 → 下一次调用重新拉起；closeAll() 之后没有活跃会话
 *   E 握手失败：server 不回 initialize → 明确报「握手失败（可能不是 MCP stdio server）」，且不留会话
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mcpClient = require('../electron/tools/mcpClient.cjs');
const sandbox = require('../electron/sandbox.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-mcp-session-'));
const logFile = path.join(root, 'mcp-log.jsonl');
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

const SERVER = path.join(__dirname, 'lib', 'mock-mcp-server.cjs');
function extension(extra) {
  return Object.assign(
    {
      name: 'mock-mcp',
      kind: 'mcp',
      // 可执行文件路径含空格必须**加引号**（splitCommand 的既定口径；不加会被按空格拆开 → spawn ENOENT）
      command: '"' + process.execPath + '" "' + SERVER + '" "' + logFile + '"',
      timeoutMs: 20000,
      idleMs: 1500,
      source: 'test',
    },
    extra || {}
  );
}

function logEntries() {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function countMethod(method) {
  return logEntries().filter((e) => e.method === method).length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // ==================== A. 会话复用 + tools/list 只问一次 ====================
  console.log('\n== A. 会话复用 ==');
  {
    mcpClient.resetStats();
    const ext = extension();
    const first = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'one' }, null, undefined);
    const second = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'two' }, null, undefined);
    check('[A] 第一次调用成功且内容正确', first.ok === true && /ECHO:one/.test(String(first.output)), String(first.output).slice(0, 60));
    check('[A] 第二次调用成功且内容正确', second.ok === true && /ECHO:two/.test(String(second.output)), String(second.output).slice(0, 60));
    const pids = [...new Set(logEntries().map((e) => e.pid))];
    check('[A] server 只被 spawn 一次（会话复用）', pids.length === 1, 'pids=' + JSON.stringify(pids));
    check('[A] initialize 只做一次', countMethod('initialize') === 1, 'initialize=' + countMethod('initialize'));
    check('[A] tools/list 只问一次（缓存）', countMethod('tools/list') === 1, 'tools/list=' + countMethod('tools/list'));
    check('[A] tools/call 两次', countMethod('tools/call') === 2, 'tools/call=' + countMethod('tools/call'));
    check('[A] 声明清单被缓存下来（echo/crash）', Array.isArray(first.declaredTools) && first.declaredTools.join(',') === 'echo,crash', JSON.stringify(first.declaredTools));
    check('[A] 第二次调用复用了同一条会话（统计可回查）', mcpClient.snapshot().reused >= 1, JSON.stringify(mcpClient.snapshot()));
  }

  // ==================== B. 未声明的工具：如实标注而不是越权拦截 ====================
  console.log('\n== B. 清单外工具 ==');
  {
    const ext = extension();
    const res = await mcpClient.callTool(root, ext, { name: 'not-declared' }, {}, null, undefined);
    check('[B] 调用仍然发出去（不擅自当权限门）', countMethod('tools/call') >= 3, 'tools/call=' + countMethod('tools/call'));
    check('[B] server 报的错如实回传', res.ok === false && /unknown tool/.test(String(res.error)), String(res.error).slice(0, 60));
  }

  // ==================== C. 崩溃 → 下次重新拉起 ====================
  console.log('\n== C. 崩溃语义 ==');
  {
    mcpClient.resetStats();
    const before = mcpClient.snapshot().spawns;
    // 独立扩展名 = 全新会话：否则本段会复用 B 段留下的会话，spawn 计数就说不清是「复用」还是「重拉」
    const ext = extension({ name: 'mock-mcp-c' });
    const okCall = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'pre' }, null, undefined);
    const crash = await mcpClient.callTool(root, ext, { name: 'crash' }, {}, null, undefined);
    check('[C] 崩溃调用如实报错（不是静默成功）', crash.ok === false && /进程提前退出/.test(String(crash.error)), String(crash.error).slice(0, 70));
    check('[C] 崩溃后**这条**会话被清掉（按会话键断言，不受别的章节影响）', mcpClient.activeKeys().includes(mcpClient.sessionKey(root, ext)) === false, JSON.stringify(mcpClient.activeKeys().length));
    const revived = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'post' }, null, undefined);
    check('[C] 下一次调用重新拉起并成功', okCall.ok === true && revived.ok === true && /ECHO:post/.test(String(revived.output)), String(revived.output || '').slice(0, 50));
    check('[C] 确实多 spawn 了一次（崩溃 + 重拉 = 2）', mcpClient.snapshot().spawns === 2, JSON.stringify(mcpClient.snapshot().spawns));
  }

  // ==================== D. 空闲回收 + closeAll ====================
  console.log('\n== D. 空闲回收 ==');
  {
    mcpClient.resetStats();
    const ext = extension({ name: 'mock-mcp-d', idleMs: 300 });
    const first = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'idle' }, null, undefined);
    check('[D] 调用成功后这条会话仍活跃（复用窗口内）', first.ok === true && mcpClient.activeKeys().includes(mcpClient.sessionKey(root, ext)) === true, JSON.stringify(mcpClient.snapshot()));
    await sleep(900);
    check('[D] 空闲到点自动关闭这条会话（不留孤儿进程）', mcpClient.activeKeys().includes(mcpClient.sessionKey(root, ext)) === false && mcpClient.snapshot().idleClosed === 1, JSON.stringify(mcpClient.snapshot()));
    const again = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'again' }, null, undefined);
    check('[D] 空闲关闭后下一次调用重新拉起', again.ok === true && mcpClient.snapshot().spawns === 2, JSON.stringify(mcpClient.snapshot()));
    const closed = mcpClient.closeAll();
    check('[D] closeAll 关掉全部会话并返回条数，且之后没有活跃会话', closed >= 1 && mcpClient.snapshot().active === 0, JSON.stringify({ closed }));
    check('[D] 主动关闭不计入 crashes（数字是给监控看的，不能全是噪声）', mcpClient.snapshot().crashes === 0, JSON.stringify(mcpClient.snapshot()));
  }

  // ==================== E. 握手失败 ====================
  console.log('\n== E. 握手失败 ==');
  {
    const logFile2 = path.join(root, 'no-handshake.jsonl');
    const ext = {
      name: 'bad-mcp',
      kind: 'mcp',
      command: '"' + process.execPath + '" "' + SERVER + '" "' + logFile2 + '" --握不上手',
      timeoutMs: 4000,
      idleMs: 1000,
      source: 'test',
    };
    const res = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'x' }, null, undefined);
    check('[E] 握手失败 → 明确报「握手失败 + 可能不是 MCP server」', res.ok === false && /握手失败/.test(String(res.error)) && /可能不是 MCP server/.test(String(res.error)), String(res.error).slice(0, 80));
    check('[E] 失败后不留会话', mcpClient.activeKeys().includes(mcpClient.sessionKey(root, ext)) === false, JSON.stringify(mcpClient.activeKeys().length));
  }

  // ==================== F. 与 extensions 注册表的接线 ====================
  console.log('\n== F. 接线 ==');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'extensions.cjs'), 'utf8');
    check('[F] runMcpTool 走 mcpClient（旧实现已删除）', /return mcpClient\.callTool\(/.test(src) && !/send\(\{ jsonrpc: '2\.0', id: 2, method: 'tools\/call'/.test(src));
    const ipc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'agent.cjs'), 'utf8');
    check('[F] run 结束统一关会话（不留孤儿进程）', /mcpClient\.cjs'\)\.closeAll\(\)/.test(ipc));
    const sandboxSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'mcpClient.cjs'), 'utf8');
    check('[F] 仍走 guardedMcpSpawn（隔离口径没被「复用」放松）', /sandbox\.guardedMcpSpawn\(/.test(sandboxSrc));
    check('[F] 仍有 1MiB 响应上限', /MAX_BUFFER_BYTES = 1024 \* 1024/.test(sandboxSrc));
  }

  mcpClient.closeAll();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'MCP SESSION TEST: PASS' : 'MCP SESSION TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('MCP SESSION TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
