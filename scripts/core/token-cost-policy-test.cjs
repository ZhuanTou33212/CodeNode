'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const settings = require("../../electron/costSettings.cjs");
const { CostLedger } = require("../../electron/costLedger.cjs");
const { SubagentManager } = require("../../electron/subagents.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const toolkit = require("../../electron/tools/toolkit.cjs");
const routing = require("../../electron/modelRouting.cjs");
const agent = require("../../electron/agent.cjs");
const { RequestBudget } = require("../../electron/requestBudget.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-token-policy-'));
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
let server;
(async () => {
  const defaults = settings.parseSettings();
  fs.mkdirSync(path.join(root, '.codenode'));
  fs.writeFileSync(path.join(root, '.codenode/agent.properties'), 'tools.confirm_writes=false\ncustom.retained=yes\n');
  const saved = settings.writeSettings(root, { ...defaults, roleModels: { ...defaults.roleModels, explorer: 'cheap-connected' },
    roleBudgets: { ...defaults.roleBudgets, explorer: { maxTurns: 3, tokenBudget: 30000, maxOutputTokens: 1024 } } }, id => ({ id, enabled: true }));
  const cfg = agent.loadConfig(root);
  assert.deepEqual(cfg.costSettings, saved);
  const before = fs.readFileSync(path.join(root, '.codenode/agent.properties'), 'utf8');
  assert.match(before, /custom.retained=yes/); assert.match(before, /tools.confirm_writes=false/);
  assert.throws(() => settings.writeSettings(root, saved, () => null), /不可用/);
  assert.equal(fs.readFileSync(path.join(root, '.codenode/agent.properties'), 'utf8'), before);
  assert.throws(() => settings.writeSettings(root, { ...saved, roleModels: { ...saved.roleModels, explorer: 'x\napi_key=secret' } }, () => ({})), /ID 无效/);
  assert.throws(() => settings.writeSettings(root, { ...saved, roleBudgets: { ...saved.roleBudgets, explorer: { maxTurns: -1, tokenBudget: 0, maxOutputTokens: 0 } } }, () => ({})), /非负整数/);
  assert.equal(fs.readFileSync(path.join(root, '.codenode/agent.properties'), 'utf8'), before, 'Invalid budgets do not overwrite settings');
  assert.deepEqual(settings.taskBudget({ limits: { maxToolIterations: 2 } }, { maxTotalTokens: 10000 }, 'explorer', { maxTurns: 20, tokenBudget: 100000 }, saved),
    { maxTurns: 2, tokenBudget: 10000, maxOutputTokens: 1024 });
  assert.deepEqual(settings.taskBudget({ limits: { maxToolIterations: 12 } }, { maxTotalTokens: 120000 }, 'explorer', { maxTurns: 1, tokenBudget: 5000 }, saved),
    { maxTurns: 1, tokenBudget: 5000, maxOutputTokens: 1024 });

  for (const objective of ['read src/app.ts', '读取 src/app.ts', '请 阅读 `src/app.ts`']) assert.equal(settings.delegationDecision({ role: 'explorer', objective }, defaults).delegate, false);
  for (const args of [
    { role: 'explorer', objective: 'read src/app.ts then investigate all references' },
    { role: 'builder', objective: '修复 src/app.ts 并运行测试' },
    { role: 'reviewer', taskSize: 'single_step' }, { role: 'verifier', taskSize: 'single_step' },
    { role: 'explorer', taskSize: 'single_step', stageNodeId: 'stage1' },
    { role: 'builder', taskSize: 'single_step', dependsOnTaskIds: ['task1'] },
  ]) assert.equal(settings.delegationDecision(args, defaults).delegate, true);
  assert.equal(settings.delegationDecision({ role: 'builder', taskSize: 'single_step' }, defaults).delegate, false);
  assert.equal(settings.delegationDecision({ role: 'explorer', objective: 'read src/app.ts' }, { ...defaults, delegationGate: false }).delegate, true);

  const requests = [];
  server = http.createServer((req, res) => {
    let text = ''; req.on('data', chunk => text += chunk); req.on('end', () => {
      const body = JSON.parse(text); requests.push({ path: req.url, authorization: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '独立分析已完成。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const ledger = new CostLedger({ projectRoot: root, runId: 'policy', prices: { expensive: { in: 10, out: 20 } } });
  Object.assign(cfg, { apiBase: base + '/main', apiKey: 'synthetic-main-key', model: 'expensive', protocol: 'openai', auth: 'bearer',
    endpoint: 'azure', azureDeployment: 'old-deployment', apiVersion: 'old-version',
    costLedger: ledger, costRunId: 'policy', costPrices: { expensive: { in: 10, out: 20 } },
    requestBudget: new RequestBudget(600000), costSettings: saved,
    limits: { ...cfg.limits, outputTiers: false }, modelRouting: { candidates: {}, routes: {}, fallbacks: [] },
  });
  const cheap = { id: 'cheap-connected', apiBase: base + '/child', apiKey: 'synthetic-child-key', model: 'cheap', supportsEffort: false, priceInput: 1, priceOutput: 2, enabled: true };
  cfg.resolveRoleModel = (role, parent) => settings.childConfig(parent, role, saved, id => id === cheap.id ? cheap : null);
  const child = cfg.resolveRoleModel('explorer', cfg);
  assert.equal(child.endpoint, ''); assert.equal(child.azureDeployment, ''); assert.equal(child.apiVersion, '');
  assert.equal(child.apiKey, cheap.apiKey); assert.equal(child.reasoningEffort, null);
  assert.equal(cfg.apiKey, 'synthetic-main-key'); assert.equal(cfg.model, 'expensive');
  assert.throws(() => settings.childConfig(cfg, 'explorer', saved, () => null), /不可用/);
  assert.throws(() => settings.childConfig(cfg, 'explorer', saved, () => ({ ...cheap, apiBase: 'https://synthetic.invalid', apiKey: '' })), /凭据/);
  const unknown = settings.childConfig(cfg, 'explorer', saved, () => ({ ...cheap, model: 'expensive', priceInput: undefined, priceOutput: undefined }));
  assert.equal(unknown.costPrices.expensive, undefined, 'No inherited price for another connection with same model ID');
  const legacy = { ...cfg, modelRouting: routing.parseConfig({ 'agent.model_candidate.small.model': 'small', 'agent.model_route.subagent': 'small' }) };
  assert.equal(routing.selection(settings.childConfig(legacy, 'builder', defaults, () => null)).entries[0].cfg.model, 'small');
  assert.equal(routing.selection(settings.childConfig(legacy, 'explorer', saved, () => cheap)).entries[0].cfg.model, 'cheap', 'Explicit UI role wins over generic route');
  const context = new AgentToolContext({ projectRoot: root, model: new (require("../../electron/tools/GraphModel.cjs").GraphModel)({ root: { nodes: [], edges: [] } }), audit: () => {}, confirm: async () => true, runId: 'policy' });
  const manager = new SubagentManager({ agent, toolkit, cfg, runId: 'policy' });
  const gated = await manager.delegate(context, { role: 'explorer', objective: 'read src/app.ts' });
  assert.equal(gated.ok, false); assert.equal(gated.data.code, 'DELEGATION_NOT_NEEDED');
  assert.equal(requests.length, 0); assert.equal(manager.tasks.size, 0); assert.equal(manager.startedTaskCount, 0);
  const result = await manager.delegate(context, { role: 'explorer', objective: 'Locate the implementation and compare its callers', taskSize: 'multi_step' });
  assert.equal(result.ok, true, result.text);
  assert.equal(requests.length, 1); assert.equal(requests[0].body.model, 'cheap');
  assert.equal(requests[0].body.max_tokens, 1024);
  assert.equal(manager.tasks.get(result.data.taskId).maxTurns, 3);
  assert.equal(manager.tasks.get(result.data.taskId).tokenBudget, 30000);
  assert.equal(requests[0].authorization, 'Bearer synthetic-child-key'); assert.match(requests[0].path, /^\/child\//);
  assert.equal(ledger.entries.length, 1, 'No duplicate child charge');
  assert.equal(ledger.entries[0].role, 'explorer'); assert.equal(ledger.entries[0].taskId, result.data.taskId);
  assert.equal(ledger.entries[0].executionId, manager.tasks.get(result.data.taskId).executionId);
  assert.equal(ledger.summary().totalTokens, 150); assert.equal(ledger.summary().costUsd, 0.00018);
  assert.equal(ledger.taskSummary().tasks[0].status, 'completed'); assert.equal(ledger.taskSummary().verifiedRuns, 0);
  assert.equal(cfg.requestBudget.used, 150, 'Child keeps shared parent budget');
  // A reviewer without a role selection inherits the main connection.
  const inherited = settings.childConfig(cfg, 'reviewer', saved, () => null);
  assert.equal(inherited.model, 'expensive'); assert.equal(inherited.apiKey, cfg.apiKey);
  const capped = settings.applyOutputBudget({ ...cfg, maxTokens: 32000 }, 1024);
  const helper = await routing.run({ ...capped, maxTokens: 8192, modelTaskType: 'compression' }, {}, null, { count: 0, maxAttempts: 1 }, async actual => ({ max: actual.maxTokens }));
  assert.equal(helper.max, 1024, 'Compression/fallback path cannot expand the role output cap');

  ledger.record({ runId: 'failed-run', kind: 'failed-attempt', model: 'expensive', usage: { prompt_tokens: 100, completion_tokens: 0 }, ok: false });
  ledger.recordOutcome({ runId: 'failed-run', status: 'failed' });
  ledger.recordOutcome({ runId: 'policy', status: 'completed', verified: true });
  const summary = ledger.taskSummary();
  assert.equal(summary.completedRuns, 1); assert.equal(summary.verifiedRuns, 1);
  assert.equal(summary.costPerVerifiedRun, 0.00118, 'Failed run costs count toward a verified delivery');
  assert.deepEqual(new CostLedger({ projectRoot: root }).taskSummary(), summary, 'Attribution and outcomes survive restart');
  ledger.record({ runId: 'unknown-price', kind: 'compression', model: 'no-price', usage: { prompt_tokens: 2, completion_tokens: 2 } });
  assert.equal(ledger.taskSummary().totalCostUsd, null);
  assert.equal(ledger.taskSummary().costPerVerifiedRun, null);
  console.log('TOKEN COST POLICY: PASS (role connection isolation, shared budgets, zero-request gate, persisted attribution, failure costs, unknown prices)');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
