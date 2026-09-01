'use strict';

/**
 * 长任务后台执行 + 轮询回归测试：
 * - execute_shell async=true 应立即返回 jobId（不阻塞前台）
 * - poll_job 可轮询到 running → done，并取得退出码/输出
 * - 任务结束后 job 被清理
 */
const assert = require('assert');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const os = require('os');
const fs = require('fs');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-bg-'));
const ctx = new AgentToolContext({ projectRoot: root, confirm: async () => true });
const reg = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true });

async function main() {
  assert.ok(reg.listTools().some((t) => t.name === 'poll_job'), '应注册 poll_job');

  const t0 = Date.now();
  const r = await reg.execute('execute_shell', { command: 'powershell Start-Sleep -Seconds 2; Write-Output BG_DONE', async: true }, ctx);
  assert.strictEqual(r.ok, true, r.text);
  assert.ok(r.data.jobId, 'async 应返回 jobId');
  assert.strictEqual(r.data.status, 'running');
  assert.ok(Date.now() - t0 < 1500, 'async 应立即返回（不阻塞前台等待 2 秒）');

  const jobId = r.data.jobId;
  const p1 = await reg.execute('poll_job', { jobId }, ctx);
  assert.ok(['running', 'done'].includes(p1.data.status), '立即 poll 应处于 running 或 done');

  // 轮询等待任务完成（CI 上 PowerShell 冷启动慢，最多等 25 秒）
  let p2 = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    p2 = await reg.execute('poll_job', { jobId, waitSeconds: 4 }, ctx);
    if (p2.data.status === 'done' || p2.data.status === 'error' || p2.data.status === 'timeout') break;
  }
  assert.strictEqual(p2.data.status, 'done', '轮询后应完成');
  assert.strictEqual(p2.data.exitCode, 0, '退出码应为 0');
  assert.ok((p2.data.output || '').includes('BG_DONE'), '应包含命令输出');

  // 已清理：再次 poll 应报不存在
  const p3 = await reg.execute('poll_job', { jobId }, ctx);
  assert.strictEqual(p3.ok, false, '任务结束后应被清理');

  // 缺失 jobId
  const bad = await reg.execute('poll_job', { jobId: 'nope' }, ctx);
  assert.strictEqual(bad.ok, false, '不存在 jobId 应报错');

  console.log('BACKGROUND JOB TEST: PASS  asyncMs=' + (Date.now() - t0));
}

main()
  .catch((error) => {
    console.error('BACKGROUND JOB TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }, 300);
    }
  });
