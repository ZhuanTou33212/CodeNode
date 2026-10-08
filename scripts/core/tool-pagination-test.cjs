/** End-to-end continuation checks for bounded file and search tool output. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toolkit = require("../../electron/tools/toolkit.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-tool-pagination-'));
  try {
    const registry = toolkit.buildDefaultRegistryWithConfig({
      projectRoot: root,
      ragEnabled: false,
      toolsAllowed: ['read_file', 'find_files', 'search_files'],
    });
    const context = new AgentToolContext({ projectRoot: root, fsWorker: false, audit: () => {} });

    const longLine = 'A'.repeat(30000);
    fs.writeFileSync(path.join(root, 'long.txt'), longLine);
    const firstRead = await registry.execute('read_file', { path: 'long.txt', maxChars: 24000 }, context);
    assert.equal(firstRead.ok, true);
    assert.equal(firstRead.data.nextOffset, 1);
    assert.equal(firstRead.data.nextCharOffset, 24000);
    const secondRead = await registry.execute('read_file', {
      path: 'long.txt', offset: firstRead.data.nextOffset,
      charOffset: firstRead.data.nextCharOffset, maxChars: 24000,
    }, context);
    assert.equal(secondRead.ok, true);
    assert.equal(secondRead.data.nextOffset, null);
    assert.equal(firstRead.text.split('\n')[1] + secondRead.text.split('\n')[1], longLine);

    fs.mkdirSync(path.join(root, 'many'));
    for (let i = 0; i < 30; i += 1) {
      fs.writeFileSync(path.join(root, 'many', 'f-' + String(i).padStart(2, '0') + '.txt'), 'needle ' + 'x'.repeat(2000));
    }
    const firstFiles = await registry.execute('find_files', { pattern: '**/*.txt', maxResults: 10 }, context);
    const secondFiles = await registry.execute('find_files', {
      pattern: '**/*.txt', maxResults: 10, offset: firstFiles.data.nextOffset,
    }, context);
    assert.equal(firstFiles.ok, true);
    assert.equal(firstFiles.data.files.length, 10);
    assert.equal(firstFiles.data.nextOffset, 10);
    assert.equal(secondFiles.ok, true);
    assert.equal(secondFiles.data.files.length, 10);
    assert.notEqual(firstFiles.data.files[0], secondFiles.data.files[0]);

    const firstSearch = await registry.execute('search_files', { pattern: 'needle', maxResults: 100 }, context);
    assert.equal(firstSearch.ok, true);
    assert.ok(firstSearch.data.nextOffset > 0 && firstSearch.data.nextOffset < 30);
    assert.ok(firstSearch.text.length < 20000);
    assert.match(firstSearch.text, new RegExp('offset=' + firstSearch.data.nextOffset));
    const secondSearch = await registry.execute('search_files', {
      pattern: 'needle', maxResults: 100, offset: firstSearch.data.nextOffset,
    }, context);
    assert.equal(secondSearch.ok, true);
    assert.ok(secondSearch.data.nextOffset > firstSearch.data.nextOffset);
    assert.notEqual(firstSearch.data.matches[0], secondSearch.data.matches[0]);
    console.log('TOOL PAGINATION TEST: PASS');
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试临时目录越界');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('TOOL PAGINATION TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
