'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.whenReady().then(async () => {
  const asar = path.resolve(process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, '../release/win-unpacked/resources/app.asar'));
  const { LocalRagIndex } = require(path.join(asar, 'electron/rag/index.cjs'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-packaged-ragworker-'));
  const index = new LocalRagIndex(root, { indexWorker: true });
  try {
    fs.mkdirSync(path.join(root, 'src/cache'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/cache/limit.ts'), 'export const packagedLimit = 9;\n');
    fs.writeFileSync(path.join(root, 'src/use.ts'), "import { packagedLimit } from './cache/limit';\nexport function allow(n) { return n < packagedLimit; }\n");
    fs.copyFileSync(path.join(__dirname, 'fixtures/rag-documents/real-word.docx'), path.join(root, 'document.docx'));
    const result = await index.retrieve('packagedLimit allow call', { mode: 'file', hops: 1 });
    if (result.stats.mode !== 'worker' || result.stats.indexedFiles !== 3 || !result.results.length ||
        !index.fileCache.get('document.docx')?.chunks.length) throw new Error(JSON.stringify(result.stats));
    if (!result.admission?.admitted || result.admission.finalSupportEvaluated !== false || result.quality.answerable !== undefined) throw new Error('Packaged retrieval/final support boundary violated');
    const { alignCitations } = require(path.join(asar, 'electron/rag/deliveryRepair.cjs'));
    const repaired = alignCitations('调用 allow。[src/use.ts#L1]', [{ name: 'read_file', ok: true, data: { path: 'src/use.ts', startLine: 1, endLine: 2, evidenceText: fs.readFileSync(path.join(root, 'src/use.ts'), 'utf8') } }]);
    if (!repaired.answer.includes('src/use.ts#L1-L2') || alignCitations('未读。[src/use.ts#L3]', [{ name: 'read_file', ok: true, data: { path: 'src/use.ts', startLine: 1, endLine: 2, evidenceText: 'one\ntwo' } }]).changes.length) throw new Error('Packaged citation repair crossed read boundary');
    const { judgeJson } = require(path.join(asar, 'electron/rag/judgeJson.cjs'));
    let protocolCalls = 0;
    const protocol = await judgeJson(async () => ++protocolCalls === 1 ? { content: '{"ok":true}', finishReason: 'length' } : { content: '{"ok":true}', finishReason: 'stop' }, [], value => { if (!value.ok) throw new Error('Invalid protocol fixture'); });
    if (protocolCalls !== 2 || protocol.judgeProtocol[0].error !== 'JUDGE_OUTPUT_TRUNCATED') throw new Error('Packaged JSON truncation protection failed');
    const { checkLiveVersions } = require(path.join(asar, 'electron/rag/liveVersions.cjs'));
    const calls = [{ name: 'retrieve_context', ok: true, data: { sources: result.results } }];
    const answer = '值为 9。[src/cache/limit.ts#L1-L1]';
    if ((await checkLiveVersions(root, answer, calls)).status !== 'verified') throw new Error('Packaged live version verification failed');
    for (const formatted of ['值为9。`src/cache/limit.ts#L1`', '值为9。[源码](src/cache/limit.ts#L1)']) {
      if ((await checkLiveVersions(root, formatted, calls)).status !== 'verified') throw new Error('Packaged citation form verification failed');
    }
    const { buildClaims, verifyFaithfulness } = require(path.join(asar, 'electron/rag/faithfulness.cjs'));
    if (buildClaims('## The limit is 999.\nThe limit is 9.').length !== 2) throw new Error('Packaged heading assertion omitted');
    const limitSource = result.results.find((source) => source.path === 'src/cache/limit.ts');
    const caption = await verifyFaithfulness('The limit is 9. [The limit is 999.](' + limitSource.citation + ')', calls,
      async () => JSON.stringify({ claims: [{ id: 1, verdict: 'entailed', evidence: [{ citation: limitSource.citation, quote: 'export const packagedLimit = 9;' }] },
        { id: 2, verdict: 'contradicted', evidence: [], reason: 'Factual link caption is wrong' }] }));
    if (caption.status !== 'judged' || caption.supported !== false) throw new Error('Packaged link assertion bypass');
    let scopeCalls = 0;
    const scoped = await verifyFaithfulness('现有源码证据不足以回答本轮问题。', [], async () => JSON.stringify(++scopeCalls === 1
      ? { claims: [{ id: 1, verdict: 'non_factual', evidence: [], reason: 'Evidence limitation' }] }
      : { disposition: 'evidence_limited_abstention', sourceSufficiency: 'insufficient', hasProjectAssertion: false, addressesQuestion: true, reason: 'No readable evidence' }),
      { question: '首次启动如何自动下载模型？' });
    if (scoped.status !== 'abstained' || scoped.supported !== false || scoped.safeForDelivery !== true) throw new Error('Packaged abstention protocol failed');
    fs.writeFileSync(path.join(root, 'src/cache/limit.ts'), 'export const packagedLimit = 8;\n');
    if ((await checkLiveVersions(root, answer, calls)).status !== 'stale') throw new Error('Packaged external change not detected');
    if ((await checkLiveVersions(root, '值为9。[源码](src/cache/limit.ts#L1)', calls)).status !== 'stale') throw new Error('Packaged link evidence freshness failure');
    console.log('PACKAGED RAG WORKER: PASS (real unpacked worker, TypeScript AST, graph snapshot, Office text, business cache path)');
  } finally {
    index.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codenode-packaged-ragworker-')) throw new Error('Unexpected cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
