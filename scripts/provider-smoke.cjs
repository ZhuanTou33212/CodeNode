'use strict';

const assert = require('assert');
const { chatCompletionStream } = require('../electron/agent.cjs');

async function main() {
  const apiKey = String(process.env.CODENODE_E2E_API_KEY || '').trim();
  if (!apiKey) {
    console.log('PROVIDER SMOKE: SKIP (set CODENODE_E2E_API_KEY to enable)');
    return;
  }
  const cfg = {
    apiBase: String(process.env.CODENODE_E2E_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey,
    model: process.env.CODENODE_E2E_MODEL || 'deepseek-v4-flash',
    maxTokens: 32,
    reasoningEffort: process.env.CODENODE_E2E_REASONING || 'low',
    reliability: { maxAttempts: 2, retryBaseMs: 500, retryMaxMs: 3000 },
  };
  const result = await chatCompletionStream(
    cfg,
    [{ role: 'user', content: 'Reply with exactly PROVIDER_SMOKE_OK and nothing else.' }],
    () => {},
    { timeoutMs: 60000 }
  );
  assert.match(String(result.content || ''), /PROVIDER_SMOKE_OK/);
  console.log('PROVIDER SMOKE: PASS', JSON.stringify({ model: cfg.model, totalTokens: result.usage && result.usage.total_tokens }));
}

main().catch((error) => {
  console.error('PROVIDER SMOKE: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
