'use strict';
const assert = require('node:assert/strict');
const { discover } = require('../electron/providerModels.cjs');
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
  console.log('PROVIDER MODELS: PASS (target isolation, errors, pagination, metadata, no key in result)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
