'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/modelStore.cjs'), 'utf8');
function load(storage) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Buffer,
    require: (name) => name === 'electron' ? { safeStorage: storage } : require(name),
  });
  return module.exports;
}
const unavailable = load({ isEncryptionAvailable: () => false });
const working = load({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('test-cipher:' + s),
  decryptString: (b) => b.toString().slice(12),
});
const broken = load({
  isEncryptionAvailable: () => true,
  decryptString: () => { throw new Error('locked'); },
});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-secret-test-'));
try {
  const file = path.join(root, 'models.json');
  assert.throws(() => unavailable.writeModels(root, [{ id: 'a', apiKey: 'synthetic-secret' }], 'a'), /拒绝保存/);
  assert.strictEqual(fs.existsSync(file), false);
  working.writeModels(root, [{ id: 'a', apiKey: 'synthetic-secret' }], 'a');
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(working.readModels(root).models[0].apiKey, 'synthetic-secret');
  assert.throws(() => broken.getModels(root, {}), /解密失败/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => unavailable.writeModels(root, [{ id: 'b', apiKey: 'another' }], 'b'), /拒绝保存/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, '{incomplete');
  assert.throws(() => working.getModels(root, {}));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{incomplete');
  working.writeModels(root, [], null);
  assert.strictEqual(working.getModels(root, {}).models.length, 0);
  console.log('MODEL STORE SECURITY: PASS (mock keyring; OS integration still required)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
