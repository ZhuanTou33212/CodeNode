'use strict';

const assert = require('assert');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');

(async () => {
  const registry = toolkit.buildDefaultRegistry();
  const context = new AgentToolContext({ projectRoot: process.cwd(), confirm: async () => true });
  // 一条命令跨平台通用：node 在 allowlist 内、由 harness 直接 spawn（不经 shell），引号由分词器处理。
  // 不用 powershell/Write-Output：POSIX 上它会被 harness 翻译成 printf，只剩几十个字符。
  const command = 'node -e "process.stdout.write(\'x\'.repeat(25000))"';
  // 冷启动的 CI Windows 上，PowerShell 首次启动 + 2 万字符经隔离层回传会超过默认 30s 超时，
  // 超时后输出被截断导致 hasMore 断言失败——这里显式给足超时，断言强度不变。
  const first = await registry.execute('execute_shell', { command, maxOutputChars: 1000, timeoutSeconds: 120 }, context);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(
    first.data.hasMore,
    true,
    '长输出应返回分页游标（实际 exitCode=' + first.data.exitCode + ' totalChars=' + first.data.totalOutputChars + ' 输出头部=' + JSON.stringify(String(first.data.output || '').slice(0, 200)) + '）'
  );
  assert.ok(first.data.jobId, '长输出应保留可继续读取的 jobId');
  assert.strictEqual(first.data.totalOutputChars > 20000, true);

  const second = await registry.execute('poll_job', {
    jobId: first.data.jobId,
    offset: first.data.nextOffset,
    maxChars: 1000,
  }, context);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.data.offset, first.data.nextOffset);
  assert.strictEqual(second.data.totalChars, first.data.totalOutputChars);
  console.log('shell output pagination ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
