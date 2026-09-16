#!/usr/bin/env node
/**
 * event-replay.cjs —— 按 run 回放统一事件流（S8）
 *
 *   node scripts/event-replay.cjs [projectRoot] [--run <runId>] [--kinds a,b]
 *                                 [--limit N] [--json] [--quiet]
 *
 * 读 `<projectRoot>/.codenode/events.jsonl`（由 electron/eventBus.cjs 写入，每条带
 * runId / turnId / toolCallId / attemptId），按 run 分组打印时序。
 *
 * 退出码：0 = 有事件输出；1 = 没有匹配事件（或事件文件不存在）—— 可直接用于门禁脚本。
 */
'use strict';

const path = require('path');
const eventBus = require('../electron/eventBus.cjs');

const argv = process.argv.slice(2);
/** @type {string[]} */
const positional = [];
let runId = null;
let kinds = null;
let limit = 0;
let asJson = false;
let quiet = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--run') runId = argv[++i] || null;
  else if (arg.startsWith('--run=')) runId = arg.slice(6);
  else if (arg === '--kinds') kinds = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (arg.startsWith('--kinds=')) kinds = arg.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
  else if (arg === '--limit') limit = Math.max(0, Number(argv[++i]) || 0);
  else if (arg.startsWith('--limit=')) limit = Math.max(0, Number(arg.slice(8)) || 0);
  else if (arg === '--json') asJson = true;
  else if (arg === '--quiet') quiet = true;
  else if (arg === '--help' || arg === '-h') {
    console.log('用法: node scripts/event-replay.cjs [projectRoot] [--run <runId>] [--kinds a,b] [--limit N] [--json]');
    process.exit(0);
  } else if (!arg.startsWith('-')) positional.push(arg);
}

const projectRoot = path.resolve(positional[0] || process.cwd());
const report = eventBus.replay(projectRoot, { runId, kinds: kinds || undefined });

if (asJson) {
  console.log(JSON.stringify({ projectRoot, file: eventBus.eventsPath(projectRoot), ...report }, null, 2));
  process.exit(report.total > 0 ? 0 : 1);
}

if (!quiet) {
  console.log('# ' + eventBus.eventsPath(projectRoot));
  console.log('# total=' + report.total + ' runs=' + report.runs.length +
    (runId ? ' run=' + runId : '') + (kinds ? ' kinds=' + kinds.join(',') : ''));
}
for (const run of report.runs) {
  console.log('');
  console.log('[' + run.runId + '] ' + run.count + ' events (' + run.kinds.join(', ') + ')');
  const events = limit > 0 ? run.events.slice(-limit) : run.events;
  if (limit > 0 && run.count > events.length) console.log('  …（只显示最后 ' + events.length + ' 条）');
  for (const event of events) console.log('  ' + eventBus.formatEvent(event));
}
process.exit(report.total > 0 ? 0 : 1);
