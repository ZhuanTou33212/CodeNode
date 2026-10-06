'use strict';
const assert = require('node:assert/strict');
const { discover, PROVIDERS } = require('../electron/providerModels.cjs');
(async () => {
  let requests = [];
  const stub = async (url, options) => { requests.push({ url, options }); return { status: 200, text: JSON.stringify({ data: [{ id: 'deepseek-test', display_name: 'Test', input_modalities: ['image'], reasoning_efforts: ['low'] }] }) }; };
  const models = await discover('deepseek', 'synthetic-key', stub);
  assert.equal(models[0].vision, true); assert.equal(models[0].supportsEffort, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://api.deepseek.com/models');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-key');
  assert.equal(JSON.stringify(models).includes('synthetic-key'), false);
  await assert.rejects(discover('guess', 'synthetic-key', stub)); assert.equal(requests.length, 1);
  await assert.rejects(discover('openai', 'synthetic-key', async () => ({ status: 401, text: 'SECRET BODY' })), /Key 无效/);
  requests = [];
  const gemini = await discover('gemini', 'synthetic-key', async (url, options) => {
    requests.push({ url, options }); return { status: 200, text: JSON.stringify(requests.length === 1
      ? { models: [{ name: 'models/gemini-test', inputTokenLimit: 12345, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'two' }
      : { models: [{ name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'] }] }) };
  });
  assert.equal(gemini.length, 1); assert.equal(gemini[0].contextWindow, 12345); assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'synthetic-key');
  assert.equal(requests[0].url.includes('synthetic-key'), false);
  for (const [id, spec] of Object.entries(PROVIDERS)) {
    let seen = '';
    const listed = await discover(id, 'synthetic-key', async (url) => {
      seen = url;
      const row = { id: 'gpt-test', name: 'models/gpt-test', supportedGenerationMethods: ['generateContent'] };
      return { status: 200, text: JSON.stringify(id === 'gemini' ? { models: [row] } : id === 'together' ? [row] : { data: [row] }) };
    });
    assert.equal(seen, spec.base + spec.list); assert.equal(listed[0].apiBase, spec.base);
  }
  let localPrivate = false;
  const local = await discover('custom', '', async (_url, options) => { localPrivate = options.allowPrivateHosts === true; return { status: 200, text: JSON.stringify({ data: [{ id: 'llama-local' }] }) }; }, { apiBase: 'http://localhost:11434/v1' });
  assert.equal(localPrivate, true); assert.equal(local[0].auth, 'none');
  const remote = await discover('custom', 'synthetic-key', async () => ({ status: 200, text: JSON.stringify({ data: [{ id: 'llama-local' }] }) }), { apiBase: 'https://gateway.example/v1' });
  assert.notEqual(local[0].id, remote[0].id, 'custom endpoints must not share model IDs');
  await assert.rejects(discover('custom', 'key', stub, { apiBase: 'http://remote.example/v1' }), /HTTPS/);
  await assert.rejects(discover('custom', 'key', stub, { apiBase: 'https://user:pass@remote.example/v1' }));
  await assert.rejects(discover('custom', 'key', stub, { apiBase: 'https://remote.example/v1?key=secret' }));
  const manual = await discover('doubao', 'synthetic-key', async () => { throw new Error('manual config must not probe endpoints'); }, { modelId: 'ep-test' });
  assert.equal(manual[0].model, 'ep-test'); assert.equal(manual[0].manual, true);
  console.log('PROVIDER MODELS: PASS (target isolation, errors, pagination, metadata, no key in result)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
