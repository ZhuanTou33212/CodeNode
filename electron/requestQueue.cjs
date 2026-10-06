'use strict';
class RequestQueue {
  constructor(limit = 4, maxWaiting = 32) { this.limit = limit; this.maxWaiting = maxWaiting; this.active = 0; this.waiting = []; this.maxWaitMs = 0; this.totalAcquired = 0; this.totalRejected = 0; }
  /** 队列指标：供成本/可靠性告警与运行指标查询使用 */
  stats() {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit, maxWaiting: this.maxWaiting, maxWaitMs: this.maxWaitMs, totalAcquired: this.totalAcquired, totalRejected: this.totalRejected };
  }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
    this.totalAcquired++;
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.releaseHandle()); }
    if (this.waiting.length >= this.maxWaiting) { this.totalRejected++; return Promise.reject(new Error('Model request queue full')); }
    const queuedAt = Date.now();
    return new Promise((resolve, reject) => {
      /** @type {{resolve: Function, reject: Function, signal: AbortSignal|undefined, abort: (() => void)|null, queuedAt: number}} */
      const item = { resolve, reject, signal, abort: null, queuedAt };
      item.abort = () => {
        this.waiting = this.waiting.filter(entry => entry !== item);
        signal.removeEventListener('abort', item.abort);
        reject(new Error('Request cancelled'));
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.waiting.push(item);
    });
  }
  releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.abort);
        const waited = Date.now() - (next.queuedAt || Date.now());
        if (waited > this.maxWaitMs) this.maxWaitMs = waited;
        next.resolve(this.releaseHandle());
      } else this.active--;
    };
  }
  async run(signal, operation) {
    const release = await this.acquire(signal);
    try {
      if (signal?.aborted) throw new Error('Request cancelled');
      return await operation();
    } finally { release(); }
  }
}
module.exports = { RequestQueue, modelQueue: new RequestQueue() };

