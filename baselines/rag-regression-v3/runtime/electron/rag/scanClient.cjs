'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
function workerFilePath() {
  return path.join(__dirname, 'scanWorker.cjs').replace(/(app\.asar)(?!\.unpacked)/, '$1.unpacked');
}
function abortError() { return Object.assign(new Error('RAG 索引刷新已取消'), { name: 'AbortError', code: 'CANCELLED' }); }
class ScanClient {
  constructor(root, options) {
    this.root = root; this.options = options; this.worker = null;
    this.sequence = 0; this.tail = Promise.resolve(); this.closed = false;
  }
  /** @returns {Promise<any>} */
  scan(payload, signal) {
    const operation = this.tail.catch(() => {}).then(() => this.run(payload, signal));
    this.tail = operation.catch(() => {});
    if (!signal) return operation;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(abortError());
      if (signal.aborted) { reject(abortError()); return; }
      signal.addEventListener('abort', cancel, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  /** @returns {Promise<any>} */
  run(payload, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    if (!this.worker) {
      this.worker = new Worker(workerFilePath(), { workerData: { root: this.root, options: this.options },
        resourceLimits: { maxOldGenerationSizeMb: 512 } });
      const created = this.worker;
      // An idle worker error must not become an unhandled EventEmitter error in the app.
      created.on('error', () => { if (this.worker === created) this.worker = null; });
      created.on('exit', () => { if (this.worker === created) this.worker = null; });
    }
    const worker = this.worker, id = ++this.sequence;
    worker.ref();
    return new Promise((resolve, reject) => {
      let done = false;
      const entries = [];
      const finish = (error, result) => {
        if (done) return;
        done = true; clearTimeout(timer);
        worker.off('message', message); worker.off('error', failure); worker.off('exit', exited);
        signal?.removeEventListener('abort', cancel);
        worker.unref();
        if (error) {
          if (this.worker === worker) this.worker = null;
          worker.terminate().catch(() => {});
          reject(error);
        } else resolve({ ...result, entries });
      };
      const message = (data) => {
        if (data.id !== id) return;
        if (data.type === 'batch') {
          entries.push(...data.entries);
          setImmediate(() => {
            if (done) return;
            try { worker.postMessage({ id, type: 'ack', batch: data.batch }); }
            catch (error) { finish(error); }
          });
        }
        else if (data.type === 'done') finish(null, data);
        else if (data.type === 'error') finish(Object.assign(new Error(data.error), { code: 'RAG_SCAN_FAILED' }));
      };
      const failure = (error) => finish(error);
      const exited = (code) => finish(Object.assign(new Error('RAG 索引 worker 提前退出：' + code), { code: 'RAG_WORKER_EXIT' }));
      const cancel = () => finish(abortError());
      const timer = setTimeout(() => finish(Object.assign(new Error('RAG 索引扫描超时'), { code: 'RAG_SCAN_TIMEOUT' })), 120000);
      worker.on('message', message); worker.once('error', failure); worker.once('exit', exited);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      worker.postMessage({ id, ...payload });
    });
  }
  close() {
    this.closed = true;
    if (this.worker) { const worker = this.worker; this.worker = null; worker.terminate().catch(() => {}); }
  }
}
module.exports = { ScanClient, workerFilePath };
