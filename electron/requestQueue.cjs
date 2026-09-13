'use strict';
class RequestQueue {
  constructor(limit = 4, maxWaiting = 32) { this.limit = limit; this.maxWaiting = maxWaiting; this.active = 0; this.waiting = []; }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.releaseHandle()); }
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new Error('Model request queue full'));
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, abort: null };
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

