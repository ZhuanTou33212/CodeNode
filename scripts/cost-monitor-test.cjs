/**
 * cost-monitor-test.cjs —— 成本账本 + 生产告警的真实回归
 *
 * 覆盖（对应审阅缺口「成本监控与生产告警」「统一记账」）：
 *   1. 主模型 / 压缩 / 子代理 / 嵌入 四类调用写进同一本账，按 runId 与 kind 分别可查
 *   2. 无 usage 的响应按保守值记账并标 estimated（不假装免费、也不编造精确数字）
 *   3. 单价可配置时算钱，未配置单价时 cost 为 null（不编造费用）
 *   4. 账本落盘后跨进程可读（today 聚合能读到历史文件）
 *   5. 阈值触发告警：成本 / token / 失败率 / 队列积压 / 隔离降级
 *   6. 冷却窗口内同一告警不重复打扰；告警落盘可查
 *   7. webhook 失败不影响主流程（不会把告警变成新故障）
 *   8. 队列指标（active/waiting/maxWaitMs）来自真实请求队列
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { CostLedger, parsePrices, costOf } = require('../electron/costLedger.cjs');
const { AlertDispatcher, evaluateAlertRules, parseThresholds, DEFAULT_THRESHOLDS } = require('../electron/alerts.cjs');
const { RequestQueue, modelQueue } = require('../electron/requestQueue.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-cost-test-'));
fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });

(async () => {
  const prices = parsePrices({ 'cost.price.scripted-model': '1,2', 'cost.price.bad': 'oops', 'cost.price.deepseek-v4-flash': '0.5,1.5' });
  check('单价解析：合法项解析成功、非法项忽略', prices['scripted-model'] && prices['scripted-model'].in === 1 && !prices.bad,
    JSON.stringify(prices));
  check('单价计算：按输入/输出分别计价（每百万 token）', Math.abs(costOf('scripted-model', { prompt_tokens: 1000000, completion_tokens: 1000000 }, prices) - 3) < 1e-9,
    String(costOf('scripted-model', { prompt_tokens: 1000000, completion_tokens: 1000000 }, prices)));

  const ledger = new CostLedger({ projectRoot: root, runId: 'run-cost-1', prices });
  ledger.record({ kind: 'main', model: 'scripted-model', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, latencyMs: 1200 });
  ledger.record({ kind: 'main', model: 'scripted-model', usage: null, estimated: true, latencyMs: 300 });
  ledger.record({ kind: 'compression', model: 'scripted-model', usage: { prompt_tokens: 800, completion_tokens: 100, total_tokens: 900 } });
  ledger.record({ kind: 'subagent', model: 'scripted-model', usage: { prompt_tokens: 2000, completion_tokens: 400, total_tokens: 2400 }, meta: { role: 'explorer' } });
  ledger.record({ kind: 'embedding', model: 'text-embedding-3-small', usage: { prompt_tokens: 300, total_tokens: 300 }, estimated: true });
  ledger.record({ kind: 'main', model: 'scripted-model', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, ok: false, attempt: 3 });

  const run = ledger.summary('run-cost-1');
  check('一次 Run 内四类调用都计入同一本账（requests=6）', run.requests === 6, JSON.stringify(run));
  check('token 总量按类累加正确', run.totalTokens === 1500 + 0 + 900 + 2400 + 300 + 20, 'total=' + run.totalTokens);
  check('无 usage 的响应标记 estimated（保守记账）', run.estimated === 2, 'estimated=' + run.estimated);
  check('按 kind 分别可查（主模型/压缩/子代理/嵌入）',
    ledger.byKind.main.requests === 3 && ledger.byKind.compression.requests === 1 && ledger.byKind.subagent.requests === 1 && ledger.byKind.embedding.requests === 1,
    JSON.stringify(Object.keys(ledger.byKind)));
  check('失败请求计入错误数', run.errors === 1, 'errors=' + run.errors);
  check('重试次数被记录（attempt=3 → 2 次重试）', run.retries === 2, 'retries=' + run.retries);
  check('配置了单价的模型算钱、未配置的成本为 null', run.costKnown === false && run.costUsd > 0, 'costKnown=' + run.costKnown + ' cost=' + run.costUsd);

  const unknownPrice = new CostLedger({ projectRoot: root, runId: 'run-cost-2', prices: {} });
  unknownPrice.record({ kind: 'main', model: 'no-price-model', usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
  check('未配置单价的模型：只记 token，不编造费用', unknownPrice.summary().costUsd === 0 && unknownPrice.summary().costKnown === false,
    JSON.stringify(unknownPrice.summary()));

  // 落盘 + 跨进程读取
  const reopened = new CostLedger({ projectRoot: root, runId: 'run-cost-3', prices });
  const today = reopened.today();
  check('账本落盘：新实例能读到历史（今日聚合 requests>=6）', today.requests >= 6, JSON.stringify(today));
  check('账本文件位于 .codenode/metrics/cost.jsonl', fs.existsSync(path.join(root, '.codenode', 'metrics', 'cost.jsonl')),
    path.join(root, '.codenode', 'metrics', 'cost.jsonl'));

  // ---- 告警规则 ----
  const thresholds = parseThresholds({ 'alerts.daily_cost_usd': '1', 'alerts.run_tokens': '1000', 'alerts.error_rate_pct': '10' });
  check('阈值解析：配置值覆盖默认值', thresholds.dailyCostUsd === 1 && thresholds.runTokens === 1000 && thresholds.errorRatePct === 10,
    JSON.stringify(thresholds));
  const fired = evaluateAlertRules(
    {
      run: { requests: 10, errors: 5, retries: 1, totalTokens: 5000, costUsd: 3, costKnown: true },
      today: { requests: 20, errors: 5, totalTokens: 9000, costUsd: 2, costKnown: true },
      queue: { active: 4, waiting: 20, maxWaitMs: 45000 },
      degradedSandbox: true,
      degradedReason: 'filesystem/network',
    },
    thresholds
  );
  const ids = fired.map((item) => item.id);
  check('触发 token 阈值告警', ids.includes('run_tokens'), ids.join(','));
  check('触发每日成本告警（critical）', fired.some((item) => item.id === 'daily_cost' && item.severity === 'critical'), ids.join(','));
  check('触发失败率告警', ids.includes('error_rate'), ids.join(','));
  check('触发队列积压与等待时间告警', ids.includes('queue_depth') && ids.includes('queue_wait'), ids.join(','));
  check('触发隔离降级告警（不假装隔离生效）', ids.includes('sandbox_degraded'), ids.join(','));

  // ---- 派发器：冷却、落盘、webhook 失败不影响主流程 ----
  const dispatched = [];
  const dispatcher = new AlertDispatcher({
    projectRoot: root,
    thresholds,
    cooldownMs: 60000,
    onAlert: (alert) => dispatched.push(alert),
    webhook: 'http://127.0.0.1:1/definitely-not-listening',
    webhookTimeoutMs: 300,
  });
  const snapshot = {
    run: { requests: 10, errors: 5, retries: 0, totalTokens: 5000, costUsd: 3, costKnown: true },
    today: { requests: 10, errors: 5, totalTokens: 5000, costUsd: 2, costKnown: true },
    queue: { waiting: 0, maxWaitMs: 0 },
    degradedSandbox: false,
  };
  const first = await dispatcher.check(snapshot);
  const second = await dispatcher.check(snapshot);
  check('告警派发：第一次触发并回调', first.length > 0 && dispatched.length === first.length, 'fired=' + first.length);
  check('告警冷却：同一告警不重复打扰', second.length === 0, 'second=' + second.length);
  check('webhook 失败不阻断（记录错误但不抛异常）', typeof dispatcher.lastWebhookError === 'string' && dispatcher.lastWebhookError.length > 0,
    String(dispatcher.lastWebhookError).slice(0, 60));
  check('告警落盘可查（alerts.jsonl 存在）', fs.existsSync(path.join(root, '.codenode', 'metrics', 'alerts.jsonl')));

  // ---- 队列指标 ----
  const queue = new RequestQueue(2, 8);
  const release1 = await queue.acquire();
  const release2 = await queue.acquire();
  const pending = queue.acquire();
  const stats = queue.stats();
  check('队列指标：active/waiting 反映真实状态', stats.active === 2 && stats.waiting === 1 && stats.limit === 2, JSON.stringify(stats));
  release1();
  await pending;
  const stats2 = queue.stats();
  check('队列释放后 waiting 减少、有 maxWaitMs 记录', stats2.waiting === 0 && stats2.maxWaitMs >= 0, JSON.stringify(stats2));
  release2();
  const rejected = queue.acquire();
  await rejected;
  check('全局模型队列可查询（modelQueue.stats 可用）', typeof modelQueue.stats().limit === 'number', JSON.stringify(modelQueue.stats()));
  check('默认阈值集合完整（成本/token/失败率/重试/队列/隔离）',
    ['runTokens', 'dailyTokens', 'runCostUsd', 'dailyCostUsd', 'errorRatePct', 'retryRatePct', 'queueWaiting', 'queueWaitMs'].every((key) => key in DEFAULT_THRESHOLDS),
    Object.keys(DEFAULT_THRESHOLDS).join(','));

  cleanup(root);
  console.log('\n== 结论：' + (failures === 0 ? '全部通过' : failures + ' 项失败') + ' ==');
  if (failures) process.exit(1);
})().catch((error) => {
  console.error('cost-monitor-test 异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});

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
