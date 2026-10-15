'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const recent = require('../../electron/recentProjects.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-recent-'));
try {
  const first = recent.remember(root, { root: '/workspace/a', file: '/workspace/a/a.cnode', name: 'A', openedAt: 10 });
  assert.equal(first.length, 1);
  recent.remember(root, { root: '/workspace/b', name: 'B', openedAt: 20 });
  const reopened = recent.read(root);
  assert.deepEqual(reopened.map(item => item.name), ['B', 'A']);
  recent.remember(root, { root: '/workspace/a', file: '/workspace/a/a.cnode', name: 'A updated', openedAt: 30 });
  assert.deepEqual(recent.read(root).map(item => item.name), ['A updated', 'B']);
  recent.forget(root, { root: '/workspace/b' });
  assert.deepEqual(recent.read(root).map(item => item.name), ['A updated']);
  assert.throws(() => recent.remember(root, { root: '../bad\npath' }), /无效/);
  recent.clear(root);
  assert.deepEqual(recent.read(root), []);
  assert.equal(fs.existsSync(path.join(root, 'recent-projects.json')), true);
  console.log('RECENT PROJECTS: PASS (durable userData storage, dedupe, ordering, forget and clear)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
