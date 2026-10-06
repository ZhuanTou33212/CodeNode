'use strict';

// Execute human-reviewed feedback samples through the real headless Agent
// entrypoint. This is deliberately separate from the fixed regression dataset:
// reviewed user feedback is a candidate benchmark, not an automatic truth label.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name, fallback = '') {
  const item = process.argv.find((value) => value.startsWith(name + '='));
  return item ? item.slice(name.length + 1) : fallback;
}
const root = path.resolve(arg('--root', process.cwd()));
const datasetFile = path.resolve(arg('--dataset', path.join(root, 'feedback-dataset.json')));
const reportFile = path.resolve(arg('--report', path.join(root, 'feedback-eval-report.json')));
if (!fs.existsSync(datasetFile)) { console.error('反馈数据集不存在，请先运行 feedback:dataset 导出已审核样本'); process.exit(2); }
const dataset = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
const rows = Array.isArray(dataset.dataset) ? dataset.dataset.filter((item) => item && item.input && item.expectedOutput) : [];
if (!rows.length) { console.error('没有可执行的已审核反馈样本（需要 input + expectedOutput）'); process.exit(2); }
if (!process.argv.includes('--confirm-send')) { console.error('反馈评测会把审核样本发送给当前配置的模型；请显式加 --confirm-send 才执行'); process.exit(2); }
if (!process.env.CODENODE_API_KEY) { console.error('未配置 CODENODE_API_KEY：反馈评测必须 fail-closed'); process.exit(2); }

function normalize(value) { return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
const results = [];
for (const row of rows) {
  const run = spawnSync(process.execPath, ['bin/codenode-agent.cjs', '--project', root, '--prompt', row.input, '--json'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: process.env, timeout: 180000,
  });
  const events = String(run.stdout || '').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const final = [...events].reverse().find((event) => event.kind === 'result');
  const actual = normalize(final && final.content);
  const expected = normalize(row.expectedOutput);
  const matched = !!actual && !!expected && (actual.includes(expected) || expected.includes(actual));
  results.push({ id: row.id, verdict: row.verdict, exitCode: run.status, state: final && final.state || null, matched, expectedOutput: row.expectedOutput, actualOutput: final && final.content || '', runId: final && final.runId || null });
}
const report = { version: 1, generatedAt: new Date().toISOString(), datasetFile, count: results.length, passed: results.filter((item) => item.matched).length, results };
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('FEEDBACK EVAL: ' + report.passed + '/' + report.count + ' matched; report=' + reportFile);
process.exit(report.results.every((item) => item.exitCode === 0 && item.matched) ? 0 : 1);
