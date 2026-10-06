/**
 * mock-openai-server.cjs —— 极简 OpenAI 兼容 mock（**独立进程**跑，供真机管线测试）
 *
 * 用途：在无 API Key 的环境里，让 `--mode=model` 走一遍**真实 HTTP + 真实 SSE 解析 + 真实预算判定**
 * 的链路 —— 只把「模型」换成确定性响应，其余（网络、流式累加、usage 记账、报告落盘）全是真的。
 *
 * 为什么必须是独立进程：测试侧要用 `spawnSync` 等评测进程结束，而 `spawnSync` 会**阻塞事件循环** →
 * 同一个进程里的 http server 根本 accept 不到连接，客户端会在 60s 后超时（实测踩到，
 * 症状是「服务器一条请求都没收到」。同族：任何「服务端与 spawnSync 同进程」的探针都会这样）。
 *
 * 用法：
 *   const { startMockOpenAI } = require('./lib/mock-openai-server.cjs');
 *   const mock = await startMockOpenAI({ usage: 500 });   // → { port, stop(), requests }
 *   ...spawnSync(评测)...
 *   const lines = await mock.stop();                       // 服务端收到的请求行（证明真走了 HTTP）
 *
 * 也支持直接当脚本跑：`node mock-openai-server.cjs` → 打印 `PORT=<n>` 后常驻。
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

/** 构造 OpenAI 兼容 SSE 响应体：正文分片 + 终止帧 + **单独的 usage 帧**（choices: []）+ [DONE]
 *  usage 必须单独一帧、且 `choices` 为空 —— 真实供应商与仓库的脚本化传输都是这个形状；
 *  把 usage 塞在带 choices 的那一帧里，累加器读到的 usage 是 null（实测：上层随即
 *  `Cannot read properties of null (reading 'total_tokens')`）。 */
function sseBody({ content = '已完成。', usage = { prompt_tokens: 100, completion_tokens: 400, total_tokens: 500 } } = {}) {
  return (
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content } }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [], usage }) + '\n\n' +
    'data: [DONE]\n\n'
  );
}

/** 组装 usage 对象（真实供应商的字段形状） */
function buildUsage(totalTokens) {
  const total = Number.isFinite(Number(totalTokens)) ? Number(totalTokens) : 500;
  return { prompt_tokens: 100, completion_tokens: Math.max(0, total - 100), total_tokens: total };
}

/** Node 的 `server.address()` 可能是 string（Unix socket）——收窄成端口号 */
function addressPort(server) {
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : 0;
}

/**
 * @param {{ totalTokens?: number }} [options]
 */
function createServer({ totalTokens } = {}) {
  const usage = buildUsage(totalTokens);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.method + ' ' + req.url);
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const isStream = /"stream"\s*:\s*true/.test(body);
      if (isStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.end(sseBody({ usage }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已完成。' }, finish_reason: 'stop' }], usage }));
    });
  });
  return { server, requests };
}

/** 同进程版本（仅用于不需要 spawnSync 的场景；spawnSync 会被阻塞，见文件头注释） */
function startMockOpenAIInProcess(options) {
  return new Promise((resolve) => {
    const { server, requests } = createServer(options);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: addressPort(server),
        requests,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 独立进程版本：返回 { port, stop() → requests[] } */
function startMockOpenAI(options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mock-openai-server.cjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOCK_USAGE: String((options && options.totalTokens) || 500) },
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('mock OpenAI 服务器启动超时'));
      }
    }, 15000);
    const onData = (chunk) => {
      out += String(chunk);
      const match = out.match(/PORT=(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          port: Number(match[1]),
          requests: () => out.split('\n').filter((line) => line.startsWith('REQ ')).map((line) => line.slice(4)),
          stop: () =>
            new Promise((done) => {
              child.once('exit', () => done(out.split('\n').filter((line) => line.startsWith('REQ ')).map((line) => line.slice(4))));
              child.kill();
            }),
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

module.exports = { startMockOpenAI, startMockOpenAIInProcess, sseBody };

if (require.main === module) {
  const totalTokens = Number(process.env.MOCK_USAGE || 500);
  const { server } = createServer({ totalTokens });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('PORT=' + addressPort(server) + '\n');
  });
  // 每个请求打印一行（父进程据此断言「真的走了 HTTP」）
  server.on('request', (req) => {
    process.stdout.write('REQ ' + req.method + ' ' + req.url + '\n');
  });
}
