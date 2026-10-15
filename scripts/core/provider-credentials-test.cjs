'use strict';
const assert = require('node:assert/strict');
const store = require('../../electron/modelStore.cjs');

const shared = store.shareProviderCredentials([
  { id: 'deepseek:a', provider: 'deepseek', apiBase: 'https://api.deepseek.com', apiKey: 'provider-secret' },
  { id: 'deepseek:b', provider: 'deepseek', apiBase: 'https://api.deepseek.com', apiKey: '' },
  { id: 'openai:a', provider: 'openai', apiBase: 'https://api.openai.com/v1', apiKey: '' },
]);
assert.equal(shared[1].apiKey, 'provider-secret');
assert.equal(shared[2].apiKey, '');
const publicModels = store.toPublicModels(shared);
assert.equal(publicModels[0].providerKey, 'deepseek');
assert.equal(publicModels[1].apiKeySet, true);
assert.equal(publicModels[1].apiKeyPreview, 'provider*****cret');

const custom = store.shareProviderCredentials([
  { id: 'relay:a', provider: 'custom', protocol: 'anthropic', apiBase: 'https://relay.example/v1/', apiKey: 'relay-secret' },
  { id: 'relay:b', provider: 'custom', protocol: 'anthropic', apiBase: 'https://relay.example/v1', apiKey: '' },
  { id: 'other:a', provider: 'custom', protocol: 'openai', apiBase: 'https://relay.example/v1', apiKey: '' },
]);
assert.equal(custom[1].apiKey, 'relay-secret');
assert.equal(custom[2].apiKey, '');
assert.equal(store.providerIdentity(custom[0]), store.providerIdentity(custom[1]));
assert.notEqual(store.providerIdentity(custom[0]), store.providerIdentity(custom[2]));

const recovered = store.shareProviderCredentials([
  { id: 'a', provider: 'deepseek', apiKey: 'valid' },
  { id: 'b', provider: 'deepseek', apiKey: '', apiKeyError: true },
]);
assert.equal(recovered[1].apiKey, 'valid');
assert.equal(recovered[1].apiKeyError, false);

console.log('PROVIDER CREDENTIALS: PASS (official provider sharing, custom base/protocol isolation, legacy recovery)');
