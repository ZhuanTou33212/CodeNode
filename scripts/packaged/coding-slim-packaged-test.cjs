'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rawFsModule = 'original-fs';
const rawFs = require(rawFsModule);
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const archive = path.resolve(process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, "../../release/win-unpacked/resources/app.asar"));
const sourceRoot = path.resolve(__dirname, "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-slim-package-'));
app.whenReady().then(async () => {
  let index;
  try {
    let compared = 0;
    const compareDirectory = relative => {
      for (const entry of fs.readdirSync(path.join(sourceRoot, relative), { withFileTypes: true })) {
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) compareDirectory(file);
        else if (entry.isFile()) {
          assert.deepEqual(fs.readFileSync(path.join(archive, file)), fs.readFileSync(path.join(sourceRoot, file)), 'Packaged source mismatch: ' + file);
          compared++;
        }
      }
    };
    for (const dir of ['electron', 'config', 'dist']) compareDirectory(dir);
    // electron-builder strips scripts/devDependencies/build from runtime metadata.
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    const archivePackage = JSON.parse(fs.readFileSync(path.join(archive, 'package.json'), 'utf8'));
    for (const key of ['name', 'version', 'main', 'description', 'dependencies', 'optionalDependencies']) {
      assert.deepEqual(archivePackage[key], sourcePackage[key], 'Packaged metadata mismatch: ' + key);
    }
    const packaged = relative => require(path.join(archive, relative));
    const agent = packaged('electron/agent.cjs');
    assert.equal(agent.parseRagConfig({}).embedProvider, 'none');
    assert.equal(agent.parseGroundingConfig({}).semanticMode, 'off');
    assert.equal(agent.parseGroundingConfig({ 'agent.rag.answerability': 'verify' }).answerability, false);
    const pkg = packaged('package.json');
    assert.ok(!pkg.dependencies?.['sqlite-vec'] && !pkg.optionalDependencies?.['sqlite-vec']);
    assert.ok(!fs.existsSync(path.join(archive, 'node_modules/sqlite-vec/package.json')), 'Default package must not bundle SQLite vector extension');
    assert.ok(!fs.existsSync(path.join(archive, 'node_modules/@zilliz/milvus2-sdk-node/package.json')), 'Default package must not bundle Milvus SDK');
    const { AgentToolContext } = packaged('electron/tools/context.cjs');
    const toolkit = packaged('electron/tools/toolkit.cjs');
    const { ScalarStore } = packaged('electron/scalars/index.cjs');
    const store = new ScalarStore(root);
    store.set('node:n1:goal', '保留基础属性读取', 'node');
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false });
    assert.ok(registry.contains('query_scalars'));
    assert.ok(!registry.contains('retrieve_context'));
    const result = await registry.execute('query_scalars', { key: 'node:n1:goal' }, new AgentToolContext({ projectRoot: root, scalarStore: store, ragConfig: { enabled: false } }));
    assert.equal(result.ok, true);
    assert.equal(result.data.items[0].value, '保留基础属性读取');
    fs.writeFileSync(path.join(root, 'limit.ts'), 'export const maxAttempts = 5;\n');
    const { LocalRagIndex } = packaged('electron/rag/index.cjs');
    index = new LocalRagIndex(root, { indexWorker: true });
    let modelRequests = 0;
    const retrieved = await index.retrieve('maxAttempts', { runtime: { queryPlanner: async () => { modelRequests++; throw new Error('Unexpected model request'); } } });
    assert.equal(modelRequests, 0);
    assert.equal(retrieved.stats.mode, 'worker');
    assert.ok(retrieved.results.length);
    const report = { ok: true, archive, comparedFiles: compared + 1, modelRequests,
      asarSha256: crypto.createHash('sha256').update(rawFs.readFileSync(archive)).digest('hex'),
      vectorProvider: retrieved.stats.vector.provider, scalarIndependent: true };
    fs.writeFileSync(path.join(sourceRoot, 'out/coding-slim-package-check.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('CODING SLIM PACKAGED: PASS ' + JSON.stringify(report));
    index.close(); index = null;
    app.exit(0);
  } catch (error) { console.error(error); index?.close(); app.exit(1); }
});
app.on('will-quit', () => {
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('codenode-slim-package-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
