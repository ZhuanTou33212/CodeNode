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
let showSummary = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--run') runId = argv[++i] || null;
  else if (arg.startsWith('--run=')) runId = arg.slice(6);
  else if (arg === '--kinds') kinds = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (arg.startsWith('--kinds=')) kinds = arg.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
  else if (arg === '--limit') limit = Math.max(0, Number(argv[++i]) || 0);
  else if (arg.startsWith('--limit=')) limit = Math.max(0, Number(arg.slice(8)) || 0);
  else if (arg === '--json') asJson = true;
  else if (arg === '--summary' || arg === '-s') showSummary = true;
  else if (arg === '--quiet') quiet = true;
  else if (arg === '--help' || arg === '-h') {
    console.log('用法: node scripts/event-replay.cjs [projectRoot] [--run <runId>] [--kinds a,b] [--limit N] [--json] [--summary]');
    process.exit(0);
  } else if (!arg.startsWith('-')) positional.push(arg);
}

const projectRoot = path.resolve(positional[0] || process.cwd());
const report = eventBus.replay(projectRoot, { runId, kinds: kinds || undefined });

const allEvents = report.runs.flatMap((run) => run.events);

if (asJson) {
  console.log(
    JSON.stringify(
      Object.assign(
        { projectRoot, file: eventBus.eventsPath(projectRoot) },
        report,
        showSummary ? { summary: eventBus.summarize(allEvents) } : {},
      ),
      null,
      2,
    ),
  );
  process.exit(report.total > 0 ? 0 : 1);
}

if (showSummary) {
  // 回放摘要（S8 补齐）：一眼看清「这次运行到底发生了什么」——工具序列/失败码/审批/成本
  const s = eventBus.summarize(allEvents);
  console.log('# 回放摘要 ' + eventBus.eventsPath(projectRoot));
  console.log('事件 ' + s.total + ' 条 | run ' + s.runs.length + ' 个 | 工具调用 ' + s.toolCalls +
    '（失败 ' + s.toolFailures + '）' + (s.span.first ? ' | ' + s.span.first + ' → ' + s.span.last : ''));
  for (const [name, slot] of Object.entries(s.tools).sort((a, b) => b[1].calls - a[1].calls)) {
    console.log('  工具 ' + name + ': ' + slot.calls + ' 次' + (slot.failures ? '（失败 ' + slot.failures + '）' : ''));
  }
  const codes = Object.entries(s.failureCodes);
  if (codes.length) console.log('  失败码: ' + codes.map(([code, n]) => code + '×' + n).join(', '));
  const a = s.approvals;
  if (a.issued || a.denied || a.rejected || a.consumed) {
    console.log('  审批: 签发 ' + a.issued + ' / 用户拒绝 ' + a.denied + ' / 令牌被拒 ' + a.rejected + ' / 消费 ' + a.consumed);
  }
  if (s.costUsd || s.tokens) console.log('  成本: $' + s.costUsd + ' / ' + s.tokens + ' tokens');
  console.log('  事件类型: ' + Object.entries(s.kinds).map(([kind, n]) => kind + '×' + n).join(', '));
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
