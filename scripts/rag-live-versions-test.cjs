'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkLiveVersions } = require('../electron/rag/liveVersions.cjs');
const { LocalRagIndex } = require('../electron/rag/index.cjs');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-live-versions-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-live-outside-'));
  const index = new LocalRagIndex(root);
  try {
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'export const value = 5;\n');
    const version = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const calls = [{ name: 'read_file', ok: true, data: { path: 'a.ts', sourceSha256: version,
      startLine: 1, endLine: 1, evidenceText: 'export const value = 5;' } }];
    const answer = '值为 5。[a.ts#L1-L1]';
    assert.equal((await checkLiveVersions(root, answer, calls)).status, 'verified');
    assert.equal((await checkLiveVersions(root, '值为5。[a.ts#L1]', calls)).status, 'verified');
    assert.equal((await checkLiveVersions(root, '值为5。`a.ts#L1`', calls)).status, 'verified');
    assert.equal((await checkLiveVersions(root, '值为5。[源码](a.ts#L1)', calls)).status, 'verified');
    assert.equal((await checkLiveVersions(root, '值为5。来源 a.ts#L1。', calls)).status, 'verified');
    const result = await index.retrieve('value', { mode: 'file' });
    assert.equal(result.results[0].sourceSha256, version, 'RAG version must bind the original bytes');
    const rag = [{ name: 'retrieve_context', ok: true, data: { sources: result.results } }];
    assert.equal((await checkLiveVersions(root, answer, rag)).status, 'verified');
    const stat = fs.statSync(file);
    fs.writeFileSync(file, 'export const value = 9;\n'); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.equal((await checkLiveVersions(root, answer, calls)).status, 'stale', 'Same-size/same-mtime edits must be detected');
    assert.equal((await checkLiveVersions(root, '值为5。[a.ts#L1]', calls)).status, 'stale');
    assert.equal((await checkLiveVersions(root, '值为5。[源码](a.ts#L1)', calls)).status, 'stale');
    assert.equal((await checkLiveVersions(root, '值为5。来源 a.ts#L1。', calls)).status, 'stale');
    fs.unlinkSync(file);
    assert.equal((await checkLiveVersions(root, answer, calls)).status, 'unknown');
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const privateValue = 1;');
    fs.symlinkSync(outside, path.join(root, 'jump'), 'junction');
    const escapeCalls = [{ ...calls[0], data: { ...calls[0].data, path: 'jump/secret.ts' } }];
    const escape = await checkLiveVersions(root, '值为1。[jump/secret.ts#L1-L1]', escapeCalls);
    assert.equal(escape.status, 'unknown');
    fs.unlinkSync(path.join(root, 'jump'));
    const unversioned = [{ ...calls[0], data: { ...calls[0].data, sourceSha256: undefined } }];
    assert.equal((await checkLiveVersions(root, answer, unversioned)).status, 'unknown');
    fs.writeFileSync(file, 'export const value = 5;\n');
    const racing = new LocalRagIndex(root, { rerankClient: async ({ documents }) => {
      fs.writeFileSync(file, 'export const value = 9;\n'); racing.invalidate('a.ts'); racing.refresh();
      return { results: documents.map((document, index) => ({ index, relevance_score: 1 })) };
    } });
    try { await assert.rejects(racing.retrieve('value', { mode: 'file' }), /混合版本证据/); }
    finally { racing.close(); }
    console.log('LIVE VERSIONS: PASS (read and RAG original-byte identity, external same-stat edits, delete, symlink boundary, unknown version)');
  } finally {
    index.close();
    for (const directory of [root, outside]) {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('rag-live-')) throw new Error('Unexpected cleanup directory');
    }
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
