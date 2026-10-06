/** File review previews must describe completed writes without inventing old content. */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileChangeReview } = require('../electron/tools/fileChangeReview.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

async function main() {
  const created = fileChangeReview('', 'alpha\nbeta', false);
  assert.equal(created.beforeExists, false);
  assert.equal(created.removedLines, 0);
  assert.equal(created.addedLines, 2);
  assert.doesNotMatch(created.diff, /^-/m, 'new file must not claim an old blank line was removed');
  const changed = fileChangeReview('one\ntwo', 'one\nnew', true);
  assert.equal(changed.removedLines, 1);
  assert.equal(changed.addedLines, 1);
  assert.match(changed.diff, /-two/);
  assert.match(changed.diff, /\+new/);
  assert.equal(changed.afterSha256, crypto.createHash('sha256').update('one\nnew').digest('hex'));
  assert.equal(fileChangeReview('x\n'.repeat(120), 'y\n'.repeat(120), true).truncated, true);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-file-review-'));
  try {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false,
      toolsAllowed: ['write_file', 'edit_file'] });
    const context = new AgentToolContext({ projectRoot: root, confirm: async () => true,
      audit: () => {}, notifyFileChange: () => {} });
    const written = await registry.execute('write_file', { path: 'a.txt', content: 'one\ntwo\n', backup: false }, context);
    assert.equal(written.ok, true);
    assert.equal(written.data.review.beforeExists, false);
    assert.match(written.data.review.diff, /\+one/);
    const edited = await registry.execute('edit_file', { path: 'a.txt', oldText: 'two', newText: 'new' }, context);
    assert.equal(edited.ok, true);
    assert.equal(edited.data.review.beforeExists, true);
    assert.match(edited.data.review.diff, /-two/);
    assert.match(edited.data.review.diff, /\+new/);
    assert.equal(edited.data.review.afterSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'a.txt'))).digest('hex'));
    console.log('FILE CHANGE REVIEW TEST: PASS');
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试临时目录越界');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FILE CHANGE REVIEW TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
