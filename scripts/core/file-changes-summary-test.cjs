'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('@typescript/typescript6');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/fileChanges.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exported = { exports: {} };
vm.runInNewContext(compiled, { module: exported, exports: exported.exports });
const summarize = exported.exports.summarizeFileChanges;
const tools = [
  { name: 'read_file', ok: true, args: { path: 'read-only.ts' } },
  { name: 'write_file', ok: true, data: { path: 'src/a.ts', review: { beforeSha256: 'old', afterSha256: 'new', diff: '-old\n+new', addedLines: 1, removedLines: 1 } } },
  { name: 'edit_file', ok: true, args: JSON.stringify({ path: './src\\a.ts' }), data: { review: { diff: '-new\n+newer' } } },
  { name: 'edit_file', ok: false, args: { path: 'failed.ts' } },
  { name: 'write_file', args: { path: 'pending.ts' } },
  { name: 'bulk_edit', ok: true, args: { list: [{ path: 'partial-ok.txt' }, { path: 'partial-failed.txt' }] }, data: { action: 'create_files', written: ['partial-ok.txt'], errors: ['partial-failed.txt: error'] } },
  { name: 'workbench_edit', ok: true, data: { created: ['canvas-1'] } },
  { name: 'write_analysis_md', ok: true, data: { relativePath: 'notes.md' } },
  { name: 'write_file', ok: true, data: { path: 'same.txt', review: { beforeSha256: 'same', afterSha256: 'same' } } },
];
const files = summarize(tools, ['README.md', 'src/a.ts', '../outside', 'C:\\private.txt', 'same.txt']);
assert.equal(files.map(file => file.path).join(','), 'src/a.ts,partial-ok.txt,notes.md,README.md');
assert.equal(files[0].reviews.length, 2);
assert.equal(summarize([{ name: 'workbench_edit', ok: true, args: { path: 'fake.ts' } }]).length, 0);
assert.equal(summarize([{ name: 'retrieve_context', ok: true }]).length, 0);
console.log('FILE CHANGES SUMMARY: PASS (distinct successful files, partial batches, real observations, no canvas/reads/failed/pending/unchanged writes)');
