'use strict';
const assert = require('node:assert/strict');
const { buildEvidence, evidenceKey } = require("../../electron/rag/faithfulness.cjs");
const { validateRagGrounding } = require("../../electron/agent.cjs");
const { currentEvidenceCalls } = require("../../electron/rag/evidenceHistory.cjs");
const read = (path, version, text) => ({ name: 'read_file', ok: true,
  data: { path, startLine: 1, endLine: 1, binary: false, sourceSha256: version, evidenceText: text } });
const initial = read('a.ts', 'sha256:old', 'const value = 5;');
const other = read('b.ts', 'sha256:b', 'const other = 1;');
const write = { name: 'edit_file', ok: true, args: JSON.stringify({ path: 'a.ts' }), data: { path: 'a.ts', sha256: 'new' } };
const stale = [initial, other, write];
assert.equal(buildEvidence(stale).some((source) => source.citation.startsWith('a.ts#')), false);
assert.equal(buildEvidence(stale).some((source) => source.citation.startsWith('b.ts#')), true);
assert.equal(validateRagGrounding('旧值为 5。[a.ts#L1-L1]', stale).status, 'invalid');
assert.equal(validateRagGrounding('仍为 1。[b.ts#L1-L1]', stale).status, 'valid');
const fresh = [...stale, read('a.ts', 'sha256:new', 'const value = 9;')];
assert.equal(validateRagGrounding('新值为 9。[a.ts#L1-L1]', fresh).status, 'valid');
assert.ok(buildEvidence(fresh).some((source) => source.text.includes('value = 9')));
assert.ok(!buildEvidence(fresh).some((source) => source.text.includes('value = 5')));
const observedChange = [initial, read('a.ts', 'sha256:new', 'const value = 9;')];
assert.equal(buildEvidence(observedChange).length, 1);
const unknown = [...fresh, { name: 'execute_shell', ok: true, args: { command: 'some script' }, data: {} }];
assert.equal(buildEvidence(unknown).length, 0);
assert.equal(validateRagGrounding('新值为 9。[a.ts#L1-L1]', unknown).status, 'invalid', 'No-source state after invalidation cannot bypass validation');
const denied = [...fresh, { name: 'execute_shell', ok: false, data: { executed: false } }];
assert.ok(buildEvidence(denied).length > 0);
const failedUnknown = [...fresh, { name: 'write_file', ok: false, args: { path: 'a.ts' }, data: {} }];
assert.ok(!buildEvidence(failedUnknown).some((source) => source.citation.startsWith('a.ts#')));
const retrieved = [{ name: 'retrieve_context', ok: true, data: { sources: [
  { citation: 'a.ts#L1-L1', path: 'a.ts', startLine: 1, endLine: 1, excerpt: 'const value = 5;' },
  { citation: 'b.ts#L1-L1', path: 'b.ts', startLine: 1, endLine: 1, excerpt: 'const other = 1;' },
] } }, write];
assert.equal(buildEvidence(retrieved).length, 1);
const refreshed = [retrieved[0], read('a.ts', 'sha256:new', 'const value = 9;')];
assert.ok(!buildEvidence(refreshed).some((source) => source.text.includes('value = 5')));
const original = JSON.stringify(retrieved);
currentEvidenceCalls(retrieved);
assert.equal(JSON.stringify(retrieved), original, 'Filtering must not rewrite audit history');
const sameAnswer = '值为 5。[a.ts#L1-L1]';
assert.notEqual(evidenceKey(sameAnswer, [initial]), evidenceKey(sameAnswer, [initial, write]));
assert.notEqual(evidenceKey(sameAnswer, [initial]), evidenceKey(sameAnswer, [read('a.ts', 'sha256:new', 'const value = 5;')]));
assert.equal(evidenceKey(sameAnswer, [initial]), evidenceKey(sameAnswer, [initial]));
const scalar = (value) => ({ name: 'query_scalars', ok: true, data: { items: [{ key: 'node:x:count', value }] } });
assert.equal(buildEvidence([scalar(5), scalar(9)])[0].text, '9');
assert.equal(buildEvidence([scalar(5), scalar(9)]).length, 1, 'The latest scalar observation replaces an older value for the same key');
assert.ok(!buildEvidence([initial, { name: 'edit_file', ok: true, args: { path: 'src/../a.ts' }, data: {} }]).length);
assert.ok(!buildEvidence([initial, { name: 'write_file', ok: false, args: { path: 'C:/project/a.ts' }, data: {} }]).length, 'Unresolved absolute write targets require conservative invalidation');
console.log('EVIDENCE HISTORY: PASS (path-local invalidation, reread restoration, observed version change, external side effects, failed unknown writes, denied execution, RAG filtering, no bypass, immutable audit)');
