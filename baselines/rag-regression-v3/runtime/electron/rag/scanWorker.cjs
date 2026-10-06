'use strict';
// Real-filesystem worker: all imported dependencies are packaged as asarUnpack.
const { parentPort, workerData } = require('node:worker_threads');
const port = parentPort;
if (!port) throw new Error('RAG 扫描入口只能在 worker 中运行');
const { LocalRagIndex } = require('./index.cjs');
const index = new LocalRagIndex(workerData.root, { ...workerData.options, indexWorker: false, embedProvider: 'none' });
const acknowledgements = new Map();
port.on('message', async (request) => {
  if (request.type === 'ack') {
    const key = request.id + ':' + request.batch;
    const resolve = acknowledgements.get(key);
    if (resolve) { acknowledgements.delete(key); resolve(); }
    return;
  }
  try {
    const before = new Map(index.fileCache);
    const previousGraph = index.graph;
    for (const file of request.dirty || []) index.invalidate(file);
    const stats = index.refresh(request.force === true);
    const updates = [...index.fileCache].filter(([file, entry]) => before.get(file) !== entry);
    const removed = [...before.keys()].filter((file) => !index.fileCache.has(file));
    for (let offset = 0; offset < updates.length; offset += 16) {
      const batch = offset / 16;
      const acknowledged = new Promise((resolve) => acknowledgements.set(request.id + ':' + batch, resolve));
      port.postMessage({ id: request.id, type: 'batch', batch, entries: updates.slice(offset, offset + 16) });
      await acknowledged;
    }
    port.postMessage({ id: request.id, type: 'done', removed, stats,
      graph: index.graph && previousGraph !== index.graph ? index.graph.toSnapshot() : null });
    index.pendingChange = { deleted: [], upserted: [] };
  } catch (error) {
    port.postMessage({ id: request.id, type: 'error', error: String(error.message || error) });
  }
});
