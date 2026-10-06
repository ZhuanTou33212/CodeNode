'use strict';
const assert = require('node:assert/strict');
const { MemoryVectorStore } = require('../electron/vectorStore/memory.cjs');
const chunk = (content) => ({ id: 'a.ts:1:2', path: 'a.ts', content });
async function main() {
  const store = new MemoryVectorStore({ maxVectors: 5000 });
  let calls = 0;
  let release = (vectors) => {};
  const embedder = { isLocal: () => false, model: 'one', signal: null, budget: null,
    embed: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } };
  const first = store.chunkVector(chunk('same'), embedder);
  const second = store.chunkVector(chunk('same'), { ...embedder });
  assert.equal(calls, 1, 'Concurrent identical documents must share computation in the same owner scope');
  release([[1, 0]]);
  assert.deepEqual(await first, [1, 0]); assert.deepEqual(await second, [1, 0]);
  assert.equal((await store.stats()).pending, 0);
  const resolvers = [];
  const slow = { ...embedder, embed: async () => new Promise((resolve) => resolvers.push(resolve)) };
  const old = store.chunkVector(chunk('old'), slow);
  store.dropLocal('a.ts', ['a.ts:1:2']);
  const changed = store.chunkVector(chunk('new'), slow);
  resolvers[1]([[0, 1]]); await changed;
  resolvers[0]([[1, 0]]); await old;
  assert.deepEqual(await store.chunkVector(chunk('new'), slow), [0, 1], 'Old completion must not overwrite new cached content');
  assert.equal(resolvers.length, 2);
  const owners = new MemoryVectorStore();
  const pending = [];
  const ownerA = { ...slow, budget: {}, signal: new AbortController().signal,
    embed: async () => new Promise((resolve) => pending.push(resolve)) };
  const ownerB = { ...ownerA, budget: {} };
  const ownerC = { ...ownerA, signal: new AbortController().signal };
  const a = owners.chunkVector(chunk('shared'), ownerA), b = owners.chunkVector(chunk('shared'), ownerB), c = owners.chunkVector(chunk('shared'), ownerC);
  assert.equal(pending.length, 3, 'Budget and cancellation scope differences must each independently prevent sharing');
  pending[0]([[1, 0]]); pending[1]([[1, 0]]); pending[2]([[1, 0]]); await Promise.all([a, b, c]);
  const late = new MemoryVectorStore();
  let finish = (vectors) => {};
  const oldPending = late.chunkVector(chunk('later'), { ...slow, embed: async () => new Promise((resolve) => { finish = resolve; }) });
  await late.close(); finish([[1, 0]]); await oldPending;
  assert.equal((await late.stats()).vectors, 0, 'Close must stop late cache writes');
  assert.equal(store.maxVectors, 5000);
  const broken = new MemoryVectorStore();
  await assert.rejects(broken.scoreCandidates('q', [chunk('x')], { isLocal: () => false,
    embed: async (texts, options) => options.inputType === 'query' ? [[1, 0]] : [[1, 0, 0]] }), /维度不一致/);
  await assert.rejects(broken.chunkVector(chunk('nan'), { ...slow, embed: async () => [[NaN, 0]] }), /数值无效/);
  assert.equal(broken.inflight.size, 0, 'Failed requests must release pending descriptors');
  await assert.rejects(broken.scoreCandidates('q', [chunk('x')], { isLocal: () => false, embed: async () => [[NaN]] }), /查询向量无效/);
  console.log('VECTOR CONCURRENCY: PASS (same-scope dedupe, distinct budgets/signals, stale result fencing, close fencing, cache sizing, vector validation)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
