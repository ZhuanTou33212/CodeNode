'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cnode = require('../electron/cnode.cjs');
const { register } = require('../electron/ipc/project.cjs');

const handlers = new Map();
let chosenPath;
register(/** @type {any} */ ({
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: chosenPath }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [chosenPath] }),
  },
  getFocusedWindow: () => null,
  sandbox: {},
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-project-create-'));
const originalMkdir = fs.mkdirSync;
const originalWrite = fs.writeFileSync;
const originalRead = fs.readFileSync;
const originalRename = fs.renameSync;

async function main() {
  chosenPath = path.join(root, 'new.cnode');
  // An existing drive root may reject a redundant mkdir on Windows.
  fs.mkdirSync = (target, options) => {
    if (path.resolve(target) === root) throw new Error('EPERM: existing root');
    return originalMkdir(target, options);
  };
  const created = await handlers.get('project:create')();
  assert.deepEqual(created, { ok: true, filePath: chosenPath, root });
  assert.equal(cnode.decodeCnode(fs.readFileSync(chosenPath)).ok, true);

  const saved = await handlers.get('project:save')(null, chosenPath, { graph: { nodes: [], edges: [] } });
  assert.deepEqual(saved, { ok: true, filePath: chosenPath });

  fs.writeFileSync = (target, data) => {
    if (target === chosenPath || typeof target === 'number') throw new Error('EPERM: write denied');
    return originalWrite(target, data);
  };
  fs.mkdirSync = originalMkdir;
  fs.renameSync = (source, target) => {
    if (target === chosenPath) throw new Error('EPERM: write denied');
    return originalRename(source, target);
  };
  const failed = await handlers.get('project:create')();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /EPERM: write denied/);

  const saveFailed = await handlers.get('graph:save')(null, { graph: { nodes: [], edges: [] } });
  assert.equal(saveFailed.ok, false);
  assert.match(saveFailed.error, /EPERM: write denied/);
  fs.writeFileSync = originalWrite;
  fs.renameSync = originalRename;

  originalWrite(chosenPath, Buffer.from('invalid cnode file'));
  const invalid = await handlers.get('graph:open')();
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /不是有效的 .cnode 文件/);

  Object.defineProperty(fs, 'readFileSync', { configurable: true, writable: true, value: (target, ...args) => {
    if (target === chosenPath) throw new Error('EPERM: read denied');
    return originalRead(target, ...args);
  } });
  const openFailed = await handlers.get('graph:open')();
  assert.equal(openFailed.ok, false);
  assert.match(openFailed.error, /EPERM: read denied/);
  console.log('PROJECT CREATE TEST: PASS');
}

main().catch((error) => {
  console.error('PROJECT CREATE TEST: FAIL', error);
  process.exitCode = 1;
}).finally(() => {
  fs.mkdirSync = originalMkdir;
  fs.writeFileSync = originalWrite;
  fs.readFileSync = originalRead;
  fs.renameSync = originalRename;
  fs.rmSync(root, { recursive: true, force: true });
});
