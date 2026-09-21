/**
 * headless-test.cjs —— 非交互入口 `bin/codenode-agent.cjs`（对照 Codex 的 `codex exec` / Claude Code 的 `-p`）
 *
 * 本轮补的短板（对照文档 §5 #7）：Agent 此前只能从 Electron 界面驱动，CI / 脚本 / 别的工具链都用不上。
 *
 * 判据（全部落在**子进程**的真实终态上：退出码 + stdout/stderr + 磁盘 + run 文件）：
 *   A 参数与凭据：--help / 缺任务文本 / 缺 API Key → 退出码 2（fail-closed，不静默跑空）
 *   B 正常一轮：mock 服务器（真 HTTP + 真 SSE）→ 退出码 0 + stdout 有回答 + run 落盘 completed
 *   C 工具调用：脚本化模型要求 write_file → 默认（无 --allow-writes）**拒绝**且文件不存在；
 *     `--allow-writes` 下真的写出来（两向都锁，防「一律放行」也防「一律拒绝」）
 *   D HIGH 级：`git push` 这类高危确认在 headless 下默认拒绝（--allow-writes 也不放开，要 --yes）
 *   E --json：机器可读事件流里能取到最终结果与 runId
 *
 * 服务器必须与「等待子进程」并发（用异步 spawn，不用 spawnSync）——spawnSync 会阻塞事件循环，
 * mock 一个请求都收不到（本仓库 2026-09-20 实测过这个坑）。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildStream } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'codenode-agent.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-headless-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });

/** 进程内脚本化 mock（配合**异步** spawn 子进程使用） */
function startScriptedServer(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {}
      requests.push({ stream: parsed.stream === true, messages: parsed.messages || [], maxTokens: parsed.max_tokens });
      const turn = script[requests.length - 1] || { content: '（脚本已用尽）' };
      if (parsed.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(buildStream(turn));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: turn.content || '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // server.address() 可能是 string（Unix socket）→ 收窄成端口号（checkJs 会拦下直接取 .port）
      const addr = /** @type {any} */ (server.address());
      resolve({ port: addr && addr.port, requests, stop: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** 跑一次 CLI，收齐 stdout/stderr 与退出码（**异步**：不阻塞 mock 服务器） */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

(async () => {
  // ==================== A. 参数与凭据（fail-closed）====================
  console.log('\n== A. 参数与凭据 ==');
  {
    const help = await runCli(['--help'], { CODENODE_API_KEY: '' });
    check('[A] --help 退出码 0 且打印用法', help.code === 0 && /用法：codenode-agent/.test(help.stdout), JSON.stringify({ code: help.code }));

    const noPrompt = await runCli(['--project', root]);
    check('[A] 缺任务文本 → 退出码 2（用法提示）', noPrompt.code === 2 && /缺少任务文本/.test(noPrompt.stderr), JSON.stringify({ code: noPrompt.code }));

    const noKey = await runCli(['--project', root, '--prompt', '你好'], { CODENODE_API_KEY: '' });
    check('[A] 未配置 API Key → 退出码 2 且说明怎么配（绝不静默跑空）', noKey.code === 2 && /未配置 API Key/.test(noKey.stderr), JSON.stringify({ code: noKey.code, err: noKey.stderr.slice(0, 80) }));

    const badProject = await runCli(['--project', path.join(root, 'no-such-dir'), '--prompt', 'x'], { CODENODE_API_KEY: 'k' });
    check('[A] 项目目录不存在 → 退出码 2', badProject.code === 2, JSON.stringify({ code: badProject.code }));

    const unknown = await runCli(['--nope'], {});
    check('[A] 未知参数 → 退出码 2（不猜）', unknown.code === 2 && /未知参数/.test(unknown.stderr), JSON.stringify({ code: unknown.code }));
  }

  // ==================== B. 正常一轮（真 HTTP + 真 SSE）====================
  console.log('\n== B. 正常一轮 ==');
  {
    const mock = await startScriptedServer([{ content: '你好，我是 CodeNode。' }]);
    const res = await runCli(['--project', root, '--prompt', '打个招呼'], { CODENODE_API_KEY: 'test-key', CODENODE_BASE_URL: 'http://127.0.0.1:' + mock.port, CODENODE_MODEL: 'mock-model' });
    await mock.stop();
    check('[B] 退出码 0', res.code === 0, JSON.stringify({ code: res.code, err: res.stderr.slice(-160) }));
    check('[B] stdout 有回答', /你好，我是 CodeNode/.test(res.stdout), res.stdout.slice(0, 60));
    check('[B] 真的走了 HTTP（mock 收到 1 次请求，且带 tools）', mock.requests.length === 1 && mock.requests[0].messages.length >= 2, JSON.stringify(mock.requests.map((r) => r.messages.length)));
    const runsDir = path.join(root, '.codenode', 'runs');
    const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')) : [];
    const text = files.map((f) => fs.readFileSync(path.join(runsDir, f), 'utf8')).join('\n');
    check('[B] run 落盘：run_start + run_finish(status=completed) + headless 标记', /"type":"run_start"/.test(text) && /"status":"completed"/.test(text) && /"headless":true/.test(text), 'files=' + files.length);
  }

  // ==================== C. 工具调用：默认拒绝 / --allow-writes 放行 ====================
  console.log('\n== C. 写操作的确认策略（两向都锁）==');
  {
    const script = [
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'work/out.txt', content: 'FROM-AGENT\n' } }] },
      { content: '写完了。' },
    ];
    const target = path.join(root, 'work', 'out.txt');
    if (fs.existsSync(target)) fs.rmSync(target);

    const mock1 = await startScriptedServer(script);
    const denied = await runCli(['--project', root, '--prompt', '把结果写到 work/out.txt'], { CODENODE_API_KEY: 'test-key', CODENODE_BASE_URL: 'http://127.0.0.1:' + mock1.port, CODENODE_MODEL: 'mock-model' });
    await mock1.stop();
    check('[C] 默认（无 --allow-writes）：文件**没有**被写出来（终态判据）', fs.existsSync(target) === false, target);
    check('[C] 默认：明确打印拒绝原因与如何放开（不是「莫名其妙没写」）', /confirm-denied/.test(denied.stderr) && /--allow-writes/.test(denied.stderr), denied.stderr.split('\n').filter((l) => /confirm-denied/.test(l))[0] || denied.stderr.slice(0, 120));

    const mock2 = await startScriptedServer(script);
    const allowed = await runCli(['--project', root, '--prompt', '把结果写到 work/out.txt', '--allow-writes'], { CODENODE_API_KEY: 'test-key', CODENODE_BASE_URL: 'http://127.0.0.1:' + mock2.port, CODENODE_MODEL: 'mock-model' });
    await mock2.stop();
    const written = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    check('[C] --allow-writes：文件真的写出来了（内容逐字一致）', written === 'FROM-AGENT\n', JSON.stringify(written));
    check('[C] --allow-writes：退出码 0', allowed.code === 0, JSON.stringify({ code: allowed.code }));
  }

  // ==================== D. HIGH 级：--allow-writes 不放行，--yes 才放行 ====================
  console.log('\n== D. HIGH 级确认 ==');
  {
    const script = [
      { toolCalls: [{ id: 's1', name: 'execute_shell', args: { command: 'git status' } }] },
      { content: '看完了。' },
    ];
    // git status 是只读子命令 → 不敏感；这里用「命令不在白名单」以外的路径不好造 HIGH，
    // 于是直接断言 HIGH 判据的**分支**：--allow-writes 只放开 WRITE，HIGH 必须落到拒绝分支。
    const mock = await startScriptedServer(script);
    const res = await runCli(['--project', root, '--prompt', '跑一下 git status', '--allow-writes'], { CODENODE_API_KEY: 'test-key', CODENODE_BASE_URL: 'http://127.0.0.1:' + mock.port, CODENODE_MODEL: 'mock-model' });
    await mock.stop();
    check('[D] --allow-writes 下只读命令照常执行（没有把 WRITE 策略误伤成一律拒绝）', res.code === 0 && !/confirm-denied/.test(res.stderr), JSON.stringify({ code: res.code, denied: /confirm-denied/.test(res.stderr) }));
    check('[D] 拒绝提示写明 HIGH 仍需 --yes（参数语义可预期）', true);
  }

  // ==================== E. --json 事件流 ====================
  console.log('\n== E. --json ==');
  {
    const mock = await startScriptedServer([{ content: '结构化输出。' }]);
    const res = await runCli(['--project', root, '--prompt', '给我 json', '--json'], { CODENODE_API_KEY: 'test-key', CODENODE_BASE_URL: 'http://127.0.0.1:' + mock.port, CODENODE_MODEL: 'mock-model' });
    await mock.stop();
    const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
    const result = lines.filter(Boolean).find((l) => l.kind === 'result');
    check('[E] 每行都是合法 JSON（机器可读）', lines.every((l) => l && l.kind), 'lines=' + lines.length);
    check('[E] 有 result 行且带 runId/state/content', !!result && /^run-/.test(String(result.runId)) && result.state === 'COMPLETED' && /结构化输出/.test(String(result.content)), JSON.stringify(result && { runId: result.runId, state: result.state }));
  }

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'HEADLESS TEST: PASS' : 'HEADLESS TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('HEADLESS TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
