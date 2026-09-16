/**
 * test-mode-capability-test.cjs —— CODENODE_TEST=1 不得削弱能力门（安全回归）
 *
 * 背景（审查 §7 安全清单点名的缺口）：`bridge.cjs` 在 CODENODE_TEST 下**无条件**放行
 * 确认（`if (TEST_MODE) return true`）。确认通道是审批令牌的唯一来源，一旦它被整体绕过，
 * 「破坏性操作要用户批准」「模型不能自己批准自己」这些约束在这条路径上就都不成立了。
 *
 * 判据（分四层，全部落在真实行为上）：
 *   A. bridge 语义：测试模式只自动批准可回滚的写入；HIGH（破坏性/不可撤销）默认拒绝；
 *   B. 能力门与 TEST_MODE 无关：越界写 / 只读上下文拒写 / network=deny 拒联网，
 *      在 CODENODE_TEST=1 下**必须照旧拒绝**（这是本用例的核心）；
 *   C. 没有审批通道时，需要审批的工具报 APPROVAL_REQUIRED —— 不会被「测试模式」放过；
 *   D. 静态守卫：仓库里没有任何脚本/CI 赋值 process.env.CODENODE_TEST（防它被误设进 CI/打包）。
 */
'use strict';

process.env.CODENODE_TEST = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-testmode-cap-'));
const outsideDir = path.join(os.homedir(), 'codenode-testmode-out-' + process.pid);
fs.mkdirSync(outsideDir, { recursive: true });
const slash = (p) => String(p).replace(/\\/g, '/');

function policyFor(extra) {
  return sandbox.resolvePolicy(Object.assign({ mode: 'best-effort' }, extra || {}), {
    projectRoot: root,
    userDataDir: root,
  });
}

(async () => {
  // ======================= A. bridge 的 TEST_MODE 语义 =======================
  {
    const electronId = require.resolve('electron');
    const fakeIpcMain = { handle() {}, on() {}, removeListener() {} };
    /** @type {any} */ (require.cache)[electronId] = {
      id: electronId,
      filename: electronId,
      loaded: true,
      exports: { ipcMain: fakeIpcMain },
    };
    const bridgePath = require.resolve('../electron/tools/bridge.cjs');
    delete require.cache[bridgePath];
    const { makeBridge } = require('../electron/tools/bridge.cjs');
    const bridge = makeBridge({ id: 1, isDestroyed: () => false, send: () => {} }, null);
    const write = await bridge.confirm('WRITE', '写入文件', '会改文件');
    check('A1 TEST_MODE 下 WRITE 级仍自动批准（测试便利性保留）', write === true, String(write));
    const high = await bridge.confirm('HIGH', '删除目录', '不可撤销');
    check('A2 TEST_MODE 下 HIGH 级默认拒绝（不再静默放行破坏性操作）', high === false, String(high));
    bridge.cleanup();
  }

  // ======================= B. 能力门与 TEST_MODE 无关 =======================
  {
    const policy = policyFor();
    sandbox.setDefaultPolicy(policy);
    const registry = toolkit.buildDefaultRegistryWithConfig({
      projectRoot: root,
      ragEnabled: false,
      toolsAllowed: ['execute_shell', 'write_file', 'save_project'],
    });

    const outside = path.join(outsideDir, 'pwned.txt');
    const ctx = () =>
      new AgentToolContext({
        projectRoot: root,
        confirm: async () => true, // 模拟「用户全同意」，仍不该放过越界写
        audit: () => {},
        sandbox: policy,
        signal: new AbortController().signal,
      });

    const escape = await registry.execute('execute_shell', { command: 'cmd /c echo X > ' + slash(outside) }, ctx());
    check('B1 TEST_MODE 下越界写仍被拒（PATH_OUT_OF_ROOT）', escape.ok === false && escape.data.code === 'PATH_OUT_OF_ROOT', JSON.stringify({ ok: escape.ok, code: escape.data && escape.data.code }));
    check('B2 TEST_MODE 下越界写未落盘', fs.existsSync(outside) === false, outside);

    const readOnlyCtx = new AgentToolContext({
      projectRoot: root,
      readOnly: true,
      confirm: async () => true,
      audit: () => {},
      sandbox: policy,
      signal: new AbortController().signal,
    });
    const writeRes = await registry.execute('write_file', { path: 'ro.txt', content: 'x' }, readOnlyCtx);
    check('B3 TEST_MODE 下只读上下文仍拒绝写工具', writeRes.ok === false && writeRes.data.code === 'PERMISSION_DENIED', JSON.stringify({ ok: writeRes.ok, code: writeRes.data && writeRes.data.code }));
    check('B4 只读上下文未落盘', fs.existsSync(path.join(root, 'ro.txt')) === false);

    const denyPolicy = policyFor({ network: 'deny' });
    sandbox.setDefaultPolicy(denyPolicy);
    const netCtx = new AgentToolContext({
      projectRoot: root,
      confirm: async () => true,
      audit: () => {},
      sandbox: denyPolicy,
      signal: new AbortController().signal,
    });
    const net = await registry.execute('execute_shell', { command: 'git push origin main' }, netCtx);
    check('B5 TEST_MODE 下 network=deny 仍拒绝联网命令', net.ok === false && net.data.code === 'PERMISSION_DENIED', JSON.stringify({ ok: net.ok, code: net.data && net.data.code }));
  }

  // ======================= C. 无审批通道 → APPROVAL_REQUIRED =======================
  {
    const policy = policyFor();
    sandbox.setDefaultPolicy(policy);
    const registry = toolkit.buildDefaultRegistryWithConfig({
      projectRoot: root,
      ragEnabled: false,
      toolsAllowed: ['save_project'],
    });
    // 刻意不注入 confirm：模拟「审批通道没接上」。TEST_MODE 也不该把它变成「已批准」。
    // 注意 save_project 的 schema 是空 properties + 闭合 —— 传任何字段都会被参数校验先拒掉。
    const ctx = new AgentToolContext({ projectRoot: root, audit: () => {}, sandbox: policy, saveProject: async () => true });
    const res = await registry.execute('save_project', {}, ctx);
    check('C1 没有审批通道时 save_project 报 APPROVAL_REQUIRED', res.ok === false && res.data.code === 'APPROVAL_REQUIRED', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
  }

  // ======================= D. 静态守卫：没人设置 CODENODE_TEST =======================
  {
    /** @type {string[]} */
    const offenders = [];
    const scan = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          scan(full);
          continue;
        }
        if (!/\.(cjs|js|mjs|yml|yaml|json)$/.test(entry.name)) continue;
        if (path.resolve(full) === path.resolve(__filename)) continue; // 本用例自身要开测试模式
        const text = fs.readFileSync(full, 'utf8');
        // 只查「赋值给 process.env」与「CI/workflow 里声明 env」两种真实后门形态；
        // 构造普通对象（如 envPolicy 用例）不算。
        for (const line of text.split(/\r?\n/)) {
          if (/process\.env\.CODENODE_TEST\s*=[^=]/.test(line) && !/delete\s+process\.env/.test(line)) {
            offenders.push(path.relative(process.cwd(), full) + ' :: ' + line.trim());
          }
          if (/(CODENODE_TEST)\s*:\s*['"]?1/.test(line) && /workflows|\.ya?ml/.test(full)) {
            offenders.push(path.relative(process.cwd(), full) + ' :: ' + line.trim());
          }
        }
      }
    };
    scan(path.join(process.cwd(), 'scripts'));
    scan(path.join(process.cwd(), 'electron'));
    scan(path.join(process.cwd(), '.github'));
    check('D1 仓库里没有任何地方赋值 process.env.CODENODE_TEST（含 CI）', offenders.length === 0, JSON.stringify(offenders));
  }

  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log('TEST MODE CAPABILITY TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('TEST MODE CAPABILITY TEST: ERROR', e);
  process.exit(1);
});
