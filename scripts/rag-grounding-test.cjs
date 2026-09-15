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

/* ---- 可信来源判定：不只看检索返回值，而是本轮真实读过的内容 ---- */
const readCalls = /** @type {any[]} */ ([
  {
    name: 'retrieve_context',
    data: {
      sources: [{ citation: 'docs/session.md#L1-L4', path: 'docs/session.md', startLine: 1, endLine: 4 }],
      quality: { answerable: true },
    },
  },
  { name: 'read_file', data: { path: 'src/big.cjs', startLine: 101, endLine: 300, lineCount: 900, language: 'javascript' } },
  { name: 'search_files', data: { count: 1, offset: 0, matches: ['src/hit.cjs:42: const x = 1;'] } },
  { name: 'query_scalars', data: { count: 1, items: [{ key: 'node:1', kind: 'scalar' }] } },
]);

// 1. 检索块内的更精确子区间必须算有效（此前只认精确串，精确到行的引用被误判成伪造引用）
const subRange = validateRagGrounding('依据 [docs/session.md#L3-L3]。', readCalls);
assert.strictEqual(subRange.status, 'valid');
assert.deepStrictEqual(subRange.invalid, []);

// 2. 按系统提示「先检索、再用 read_file 深读候选文件后引用」产生的引用必须算有效
assert.strictEqual(validateRagGrounding('实现见 [src/big.cjs#L150-L200]。', readCalls).status, 'valid');

// 3. 本轮确实读过该文件，但行号与读到的范围完全不相交 → 仍判无效
const outOfRange = validateRagGrounding('实现见 [src/big.cjs#L8000-L8010]。', readCalls);
assert.strictEqual(outOfRange.status, 'invalid');
assert.deepStrictEqual(outOfRange.invalid, ['src/big.cjs#L8000-L8010']);

// 4. search_files 命中的行有效，未命中过的行无效
assert.strictEqual(validateRagGrounding('见 [src/hit.cjs#L42-L42]。', readCalls).status, 'valid');
assert.strictEqual(validateRagGrounding('见 [src/hit.cjs#L77-L77]。', readCalls).status, 'invalid');

// 5. 标量引用必须能被识别（此前引用正则要求前缀至少 1 字符，[scalar:<key>] 匹配不到 → 被当成「没引用」）
const scalarHit = validateRagGrounding('取自 [scalar:node:1]。', readCalls);
assert.strictEqual(scalarHit.status, 'valid');
assert.deepStrictEqual(scalarHit.used, ['scalar:node:1']);
assert.strictEqual(validateRagGrounding('取自 [scalar:node:999]。', readCalls).status, 'invalid');

// 6. source: 前缀形态有效；普通方括号不算引用
assert.strictEqual(validateRagGrounding('见 [source: docs/session.md#L2-L2]。', readCalls).status, 'valid');
const plainBrackets = validateRagGrounding('见 [见上文] 与 [备注]。', readCalls);
assert.deepStrictEqual(plainBrackets.used, []);
assert.strictEqual(plainBrackets.status, 'missing');

// 7. ./ 前缀归一后与检索引用等价
assert.strictEqual(validateRagGrounding('见 [./docs/session.md#L2-L2]。', readCalls).status, 'valid');

// 8. 同一文件多次分段读取：每个读到的区间都可信
const multiRange = readCalls.concat([
  { name: 'read_file', data: { path: 'src/big.cjs', startLine: 301, endLine: 500, lineCount: 900 } },
]);
assert.strictEqual(validateRagGrounding('见 [src/big.cjs#L400-L420]。', multiRange).status, 'valid');

// 9. 无行号信息的读取（PDF 文字层）：整文件视为已读
const pdfLike = readCalls.concat([
  { name: 'read_file', data: { path: 'docs/manual.pdf', language: 'pdf', lineCount: 5000 } },
]);
assert.strictEqual(validateRagGrounding('见 [docs/manual.pdf#L900-L910]。', pdfLike).status, 'valid');

// 10. 二进制/未读到内容的失败读取不得产生可信来源
const binaryRead = readCalls.concat([
  { name: 'read_file', ok: false, data: { path: 'build/app.exe', binary: true } },
]);
assert.strictEqual(validateRagGrounding('见 [build/app.exe#L1-L2]。', binaryRead).status, 'invalid');

const prompt = buildSystemPrompt({ raw: '' }, '[]', [{ name: 'retrieve_context', desc: '本地检索' }]);
assert.match(prompt, /queries/);
assert.match(prompt, /不可信数据/);
assert.match(prompt, /不得编造路径、行号/);
assert.match(prompt, /质量标记为低或不可回答/);

console.log('RAG GROUNDING TEST: PASS');
