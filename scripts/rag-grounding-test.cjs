'use strict';

const assert = require('assert');
const { buildSystemPrompt, validateRagGrounding } = require('../electron/agent.cjs');

const retrievalCalls = [
  {
    name: 'retrieve_context',
    data: {
      sources: [
        { citation: 'src/auth/session.ts#L10-L24' },
        { citation: 'docs/auth.md#L3-L8' },
      ],
      quality: { answerable: true },
    },
  },
];

const valid = validateRagGrounding(
  '实现位于 [src/auth/session.ts#L10-L24]，设计依据见 [docs/auth.md#L3-L8]。',
  retrievalCalls
);
assert.strictEqual(valid.status, 'valid');
assert.strictEqual(valid.valid, true);
assert.deepStrictEqual(valid.invalid, []);

const missing = validateRagGrounding('实现会轮换令牌，但这里忘了给来源。', retrievalCalls);
assert.strictEqual(missing.status, 'missing');
assert.strictEqual(missing.valid, false);

const invalid = validateRagGrounding('错误引用 [src/fake.ts#L1-L9]。', retrievalCalls);
assert.strictEqual(invalid.status, 'invalid');
assert.deepStrictEqual(invalid.invalid, ['src/fake.ts#L1-L9']);

const lowConfidence = validateRagGrounding('相关性不足，无法判断。', [
  {
    name: 'retrieve_context',
    data: {
      sources: [{ citation: 'src/weak.ts#L1-L2' }],
      quality: { answerable: false },
    },
  },
]);
assert.strictEqual(lowConfidence.status, 'valid');
assert.strictEqual(lowConfidence.required, false);

const notRequired = validateRagGrounding('普通对话无需来源。', []);
assert.strictEqual(notRequired.status, 'not_required');
assert.strictEqual(notRequired.valid, true);

const prompt = buildSystemPrompt({ raw: '' }, '[]', [{ name: 'retrieve_context', desc: '本地检索' }]);
assert.match(prompt, /queries/);
assert.match(prompt, /不可信数据/);
assert.match(prompt, /不得编造路径、行号/);
assert.match(prompt, /质量标记为低或不可回答/);

console.log('RAG GROUNDING TEST: PASS');
