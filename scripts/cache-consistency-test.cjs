'use strict';

/**
 * 画布节点「读写不同步」回归测试：
 * 用一个本地 mock LLM（SSE /chat/completions）驱动 runAgentChat：
 *   get_workbench_model → workbench_edit(create) → get_workbench_model
 * 验证：变更后再次读取画布必须返回最新节点（而不是命中旧的只读缓存 / 0 节点）。
 */

const assert = require('assert');
const http = require('http');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { runAgentChat } = require('../electron/agent.cjs');

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

let requestCount = 0;
let readCalls = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requestCount++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    // 请求按顺序编排：1 读画布 → 2 建节点 → 3 再读画布 → 4 结束
    if (requestCount === 1) {
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_workbench_model', arguments: '{"view":"full"}' } }] } }] }));
    } else if (requestCount === 2) {
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'workbench_edit', arguments: '{"operations":[{"action":"create","name":"new_task","type":"task","prompt":"write api"}]}' } }] } }] }));
    } else if (requestCount === 3) {
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_3', type: 'function', function: { name: 'get_workbench_model', arguments: '{"view":"full"}' } }] } }] }));
    } else {
      res.write(sse({ choices: [{ delta: { content: '完成' } }] }));
      res.write(DONE);
    }
    res.end();
  });
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const model = new GraphModel({ root: { nodes: [], edges: [] } });
  const registry = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true });
  // 统计 get_workbench_model 真实执行次数（缓存命中不算执行）
  const rawExecute = registry.execute.bind(registry);
  registry.execute = async (name, args, ctx) => {
    if (name === 'get_workbench_model') readCalls++;
    return rawExecute(name, args, ctx);
  };
  const context = new AgentToolContext({
    projectRoot: null,
    model,
    mutateWorkbench: async (fn) => { fn(model); return true; },
  });

  const messages = [{ role: 'system', content: 'test' }];
  const cfg = { model: 'test', apiBase: 'http://127.0.0.1:' + port, apiKey: 'x', maxTokens: 100, reasoningEffort: '', compression: { enabled: false } };

  const result = await runAgentChat({ cfg, messages, tools: { registry, context }, signal: null, timeoutMs: 20000 });

  server.close();

  assert.strictEqual(result.error, undefined, '不应出错：' + result.error);
  assert.ok(readCalls >= 2, 'get_workbench_model 应被真实执行 ≥2 次（变更后必须重新读画布，不能命中旧缓存）');

  // 找出最后一次 get_workbench_model 的 tool 结果，确认能看到刚创建的节点
  const toolResults = messages.filter((m) => m.role === 'tool');
  const lastRead = toolResults[toolResults.length - 1];
  assert.ok(lastRead && lastRead.content.includes('工作台共 1 个节点'), '变更后再次读取应返回 1 个节点，实际：' + (lastRead && lastRead.content));
  assert.ok(lastRead.content.includes('new_task'), '读取结果应包含刚创建的节点名');

  console.log('CACHE CONSISTENCY TEST: PASS  readCalls=' + readCalls);
}

main()
  .catch((error) => {
    console.error('CACHE CONSISTENCY TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
  });
