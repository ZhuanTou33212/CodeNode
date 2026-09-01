'use strict';

const assert = require('assert');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');

(async () => {
  const registry = toolkit.buildDefaultRegistry();
  const context = new AgentToolContext({ projectRoot: process.cwd(), confirm: async () => true });
  const command = 'powershell -Command "Write-Output ([string]::new([char]120,20000))"';
  const first = await registry.execute('execute_shell', { command, maxOutputChars: 1000 }, context);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.data.hasMore, true, '长输出应返回分页游标');
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
