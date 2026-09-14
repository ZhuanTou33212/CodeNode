'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('../electron/atomicFile.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-atomic-'));
try {
  const file = path.join(root, 'nested', 'file.txt');
  atomicWriteFile(file, 'first');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'first');
  atomicWriteFile(file, 'second'.repeat(1000));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second'.repeat(1000));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp')), []);
  console.log('ATOMIC FILE: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

