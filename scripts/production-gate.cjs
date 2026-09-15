'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const agent = require('../electron/agent.cjs');
const modelStore = require('../electron/modelStore.cjs');
const runStore = require('../electron/runStore.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function main() {
  // 主进程源码含 electron/ipc/*.cjs：按域拆模块后，接线检查必须看并集
  const mainSource = require('./lib/main-process-source.cjs').readMainProcessSource();
  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /nodeIntegration:\s*false/);
  assert.match(mainSource, /sandbox:\s*true/);
  assert.match(mainSource, /maxConcurrentRuns/);
  assert.match(mainSource, /runStore\.startRun/);
  assert.match(mainSource, /runStore\.finishRun/);

  const cfg = agent.loadConfig(path.join(__dirname, '..'));
  assert.ok(cfg.limits.maxConcurrentRuns >= 1);
  assert.ok(cfg.limits.maxTotalTokens >= 10000);
  assert.strictEqual(toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'explorer' }).contains('execute_shell'), false);
  assert.strictEqual(modelStore.toPublicModel({ id: 'x', apiKey: 'secret' }).apiKey, '');
  assert.strictEqual(modelStore.toPublicModel({ id: 'x', apiKey: 'secret' }).apiKeySet, true);

  const temp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codenode-production-gate-'));
  try {
    runStore.startRun(temp, 'gate-run', { model: 'test' });
    runStore.finishRun(temp, 'gate-run', 'completed');
    assert.strictEqual(runStore.summarizeRun(runStore.readRun(temp, 'gate-run')).status, 'completed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('PRODUCTION GATE: PASS');
  // 运行时门槛（隔离 / 续跑幂等 / 成本告警）：
  // 这里不直接 return，交由 runtime-gate.cjs 独立进程执行，失败时同样非 0 退出。
  const { spawnSync } = require('child_process');
  const runtime = spawnSync(process.execPath, [path.join(__dirname, 'runtime-gate.cjs')], { stdio: 'inherit' });
  if (runtime.status !== 0) throw new Error('runtime-gate 未通过（exit=' + runtime.status + '）');
}

try {
  main();
} catch (error) {
  console.error('PRODUCTION GATE: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
