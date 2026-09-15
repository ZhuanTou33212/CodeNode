/**
 * 指标 / 成本 / 告警 / 隔离状态的总览通道：agent:metrics。
 *
 * 读一次盘（配置 + 账本 + 告警历史 + 队列 + 隔离能力 + 最近的 Run），聚合给 UI 的监控面板。
 * `CostLedger` / `AlertDispatcher` / `modelQueue` 直接在本模块 require：
 * 它们是类或单例，Node 的模块缓存保证和 main.cjs 拿到的是同一份；
 * 而 agent / sandbox / runStore 在应用内是带状态的单例，由 ctx 注入，避免隐式共享。
 */

const { CostLedger } = require('../costLedger.cjs');
const { AlertDispatcher } = require('../alerts.cjs');
const { modelQueue } = require('../requestQueue.cjs');

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   agent: any,
 *   sandbox: any,
 *   runStore: any,
 *   userDataDir: () => string,
 * }} ctx
 */
function register(ctx) {
  const { ipcMain, agent, sandbox, runStore, userDataDir } = ctx;

  ipcMain.handle('agent:metrics', async (_event, projectRoot) => {
    const cfg = agent.loadConfig(projectRoot);
    const policy = sandbox.resolvePolicy(cfg.sandbox, { projectRoot, userDataDir: userDataDir() });
    const ledger = new CostLedger({ projectRoot, runId: 'metrics-view', prices: cfg.costPrices });
    const dispatcher = new AlertDispatcher({
      projectRoot,
      thresholds: cfg.alertThresholds,
      webhook: cfg.alertWebhook || null,
    });
    const snapshot = ledger.snapshot(modelQueue.stats());
    const fired = await dispatcher
      .check({
        ...snapshot,
        degradedSandbox: policy.degraded.length > 0,
        degradedReason: policy.degraded.join('/'),
      })
      .catch(() => []);
    return {
      ok: true,
      cost: snapshot,
      firedAlerts: fired,
      alertHistory: dispatcher.recent(20),
      queue: modelQueue.stats(),
      sandbox: {
        backend: sandbox.capabilities().backend,
        isolation: sandbox.capabilities().isolation,
        detail: sandbox.capabilities().detail,
        mode: policy.mode,
        network: policy.network,
        degraded: policy.degraded,
        description: sandbox.describe(policy),
      },
      runs: projectRoot ? runStore.listRuns(projectRoot, 20) : [],
    };
  });
}

module.exports = { register };
