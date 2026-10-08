'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventBus = require("../../electron/eventBus.cjs");
const tree = require("../../electron/traceTree.cjs");

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-trace-test-'));
  try {
    const run = eventBus.startSpan(root, { spanKind: 'run', name: 'agent.run', runId: 'r1' });
    const model = eventBus.startSpan(root, { spanKind: 'model', name: 'model.request', runId: 'r1', parent: run.context, actor: 'main' });
    const tool = eventBus.startSpan(root, { spanKind: 'tool', name: 'read_file', runId: 'r1', parent: model.context, actor: 'main', toolCallId: 'c1' });
    tool.event('result', { token: 'sk-secret-must-redact' });
    tool.end('ok', { attributes: { path: 'src/a.js' } });
    model.end('ok', { model: 'test-model', usage: { total_tokens: 4 } });
    run.end('ok');
    fs.appendFileSync(eventBus.eventsPath(root), '{bad json}\n');
    const exported = eventBus.exportTrace(root);
    assert.equal(exported.complete, false, 'corrupt tail must prevent complete claim');
    assert.ok(exported.diagnostics.some((item) => item.code === 'CORRUPT_EVENT_LINE'));
    assert.equal(exported.spans.length, 3);
    assert.deepEqual(exported.spans.find((s) => s.spanKind === 'tool').children, []);
    assert.equal(exported.spans.find((s) => s.spanKind === 'model').children.length, 1);
    assert.ok(!JSON.stringify(exported).includes('sk-secret'));

    const incomplete = tree.buildTraceTree([
      { kind: 'span_start', traceId: 't', spanId: 'a', runId: 'r', ts: new Date().toISOString(), parentSpanId: 'missing' },
      { kind: 'span_end', traceId: 't', spanId: 'a', runId: 'r', status: 'ok', ts: new Date().toISOString() },
      { kind: 'span_start', traceId: 't', spanId: 'b', runId: 'r', parentSpanId: 'a', ts: new Date().toISOString() },
    ]);
    assert.ok(incomplete.diagnostics.some((item) => item.code === 'SPAN_ORPHAN'));
    assert.ok(incomplete.diagnostics.some((item) => item.code === 'SPAN_MISSING_END'));
    console.log('TRACE TREE: PASS — explicit parentage, lifecycle, corruption, redaction, orphan detection');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main();
