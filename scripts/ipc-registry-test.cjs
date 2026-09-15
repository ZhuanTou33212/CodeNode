'use strict';

/**
 * IPC 域模块注册测试：每个 electron/ipc/*.cjs 在 register(ctx) 时必须恰好注册它那一组通道。
 *
 * 为什么要有这一条：把 agent:chat 那一大块从 main.cjs 搬走时，连带删掉了夹在中间的
 * models / metrics 两处 register 调用 —— "源码里出现过通道名"的静态检查完全看不出来
 * （通道名还在模块里），而这种漏接线只会在用户点到模型管理时才炸。
 * 这里用假的 ipcMain 直接跑 register()，数它到底注册了几个、是哪几个。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXPECTED = {
  'models.cjs': ['models:list', 'models:save', 'models:delete', 'models:active'],
  'metrics.cjs': ['agent:metrics'],
  'project.cjs': [
    'graph:save', 'graph:open',
    'project:choose', 'project:create', 'project:list', 'project:read', 'project:write', 'project:search',
    'project:run', 'project:run:start', 'project:run:stop', 'project:run:input',
    'project:save', 'project:load', 'extensions:list',
  ],
  'agent.cjs': [
    'agent:config', 'agent:greeting', 'agent:tools', 'agent:runs',
    'agent:resume-plan', 'agent:resume-start', 'agent:chat', 'agent:stop',
  ],
};

const IPC_DIR = path.join(__dirname, '..', 'electron', 'ipc');

function main() {
  const files = fs.readdirSync(IPC_DIR).filter((f) => f.endsWith('.cjs')).sort();
  assert.deepStrictEqual(files, Object.keys(EXPECTED).sort(), '新增/删除 IPC 模块后需要同步更新本测试的预期表');

  let registeredTotal = 0;
  for (const file of files) {
    const channels = [];
    const ctx = {
      ipcMain: { handle: (channel) => channels.push(channel) },
      userDataDir: () => os.tmpdir(),
      dialog: {},
      getFocusedWindow: () => null,
      agent: require('../electron/agent.cjs'),
      sandbox: require('../electron/sandbox.cjs'),
      runStore: require('../electron/runStore.cjs'),
    };
    // register 只做接线，不该有副作用；抛错说明模块顶层就写坏了
    require(path.join(IPC_DIR, file)).register(ctx);
    const got = channels.slice().sort();
    const want = EXPECTED[file].slice().sort();
    assert.deepStrictEqual(got, want, `${file} 注册的通道与预期不一致（实际 ${got.length} 个：${got.join(', ')}）`);
    registeredTotal += got.length;
    console.log(`  ✓ ${file} 注册 ${got.length} 个通道`);
  }

  // 与 main.cjs 之外的源码对账：所有 ipcMain.handle/on 的通道都得在某个模块的注册里出现
  const sources = files.map((f) => fs.readFileSync(path.join(IPC_DIR, f), 'utf8')).join('\n');
  const declared = new Set((sources.match(/ipcMain\.(?:handle|on)\('([^']+)'/g) || []).map((m) => m.replace(/.*'([^']+)'/, '$1')));
  assert.strictEqual(declared.size, registeredTotal, `模块里声明的通道数(${declared.size})与实际注册数(${registeredTotal})不一致`);

  console.log(`IPC REGISTRY TEST: PASS  ${files.length} 个模块 / ${registeredTotal} 个通道`);
}

try {
  main();
} catch (error) {
  console.error('IPC REGISTRY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
