'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveInRoot } = require('../electron/tools/impl/shared.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-path-'));
const root = path.join(temp, 'project');
const outside = path.join(temp, 'outside');
const link = path.join(root, 'linked');
try {
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(resolveInRoot(root, 'linked/new.txt'), null);
  assert.strictEqual(resolveInRoot(root, '../outside/new.txt'), null);
  assert.strictEqual(resolveInRoot(root, 'safe/new.txt'), path.join(root, 'safe/new.txt'));
  console.log('PATH BOUNDARY: PASS');
} finally {
  if (fs.existsSync(link)) fs.unlinkSync(link);
  fs.rmSync(temp, { recursive: true, force: true });
}
