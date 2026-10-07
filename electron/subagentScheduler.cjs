'use strict';
const schedulingUi = require('../config/ui.scheduling.json');

/** @type {Record<string, string[]>} */
const TASK_TRANSITIONS = {
  queued: ['running', 'cancelling', 'failed', 'cancelled', 'blocked'],
  running: ['cancelling', 'done', 'failed', 'cancelled', 'blocked'],
  cancelling: ['cancelled', 'blocked', 'failed'],
  done: [], failed: [], cancelled: [], blocked: [],
};

function transitionTask(task, status) {
  if (task.status === status) return;
  if (!(TASK_TRANSITIONS[task.status] || []).includes(status)) throw new Error('非法子任务迁移：' + task.status + ' → ' + status);
  task.status = status;
  task.version = (Number(task.version) || 0) + 1;
}

/** 管理器共享 FIFO：只读任务共享槽位，写任务独占；排队可取消。 */
class SubagentScheduler {
  constructor(limit) {
    this.limit = Math.max(schedulingUi.limits.concurrency.min, Math.min(schedulingUi.limits.concurrency.max, Math.floor(Number(limit) || schedulingUi.defaults.concurrency)));
    this.active = 0;
    this.writer = false;
    this.queue = [];
  }
  acquire(readOnly, signal) {
    return new Promise((resolve, reject) => {
      const cancelled = () => Object.assign(new Error('子任务等待被取消'), { name: 'AbortError' });
      if (signal.aborted) { reject(cancelled()); return; }
      const entry = { readOnly, resolve, signal, onAbort: () => {} };
      entry.onAbort = () => {
        const at = this.queue.indexOf(entry);
        if (at < 0) return;
        this.queue.splice(at, 1);
        signal.removeEventListener('abort', entry.onAbort);
        reject(cancelled());
        this.drain();
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }
  drain() {
    while (this.queue.length && !this.writer && this.active < this.limit) {
      const next = this.queue[0];
      if (!next.readOnly && this.active > 0) return;
      this.queue.shift();
      next.signal.removeEventListener('abort', next.onAbort);
      this.active++;
      this.writer = !next.readOnly;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        if (!next.readOnly) this.writer = false;
        this.drain();
      });
    }
  }
}
module.exports = { SubagentScheduler, transitionTask };
