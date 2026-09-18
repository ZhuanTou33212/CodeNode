/**
 * leases.cjs —— 跨 Agent 的**资源租约**（多 Agent 信息完整性 P3 的「单一写者」半边）
 *
 * 问题（见 docs/multi-agent-info-integrity-2026-09-17.md §3）：两个 Agent 同时写同一个文件 /
 * 同一张画布，会**静默互相覆盖** —— 谁最后写完谁赢，另一份工作凭空消失，而且两边都以为成功了。
 * 加锁的道理很朴素：**同一个资源，同一时刻只允许一个写者**。
 *
 * 三条设计取舍：
 *   1. **不排队等待，直接如实失败**：被占用就返回 `RESOURCE_LOCKED`（可重试）+ 谁在占用。
 *      等待会引入死锁与「谁先谁后」的不确定性；失败让人（或模型）自己决定改顺序/换文件。
 *   2. **申请是原子的**：一次要多个资源键（比如批量编辑多个文件）时，要么全拿到、要么一个都不占
 *      —— 部分占用正是死锁的成因。
 *   3. **TTL 兜底**：持有者异常退出（崩溃/取消/被杀）不会永久占住资源；每次由同一持有者再次申请
 *      即续期。释放有两条正常路径：任务结束（`releaseAll(holder)`）与 TTL 到期。
 *
 * 租约只约束**写**（`descriptor.mutatesWorkspace`），读不加锁。
 */
'use strict';

const path = require('path');

/** 默认租约时长：一次写操作远用不到这么久，纯粹是「持有者崩了别永久占住」的兜底 */
const DEFAULT_TTL_MS = 120000;

/** 单资源键（画布/工程保存这类全局资源）用的固定名字 */
const CANVAS_KEY = 'resource:canvas';
const PROJECT_SAVE_KEY = 'resource:project-save';

/**
 * 从一次工具调用推出它要占用的资源键。只有写类工具会返回非空数组。
 * @param {string} name 工具名
 * @param {any} args 工具参数
 * @param {{projectRoot?: string}} [options]
 * @returns {string[]} 去重后的资源键
 */
function resourceKeysFor(name, args, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const a = args && typeof args === 'object' ? args : {};
  const keys = [];
  const pushFile = (p) => {
    const raw = String(p || '').trim();
    if (!raw) return;
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(projectRoot, raw);
    // 统一成 posix 风格：Windows 上反斜杠/大小写差异不能让同一个文件变成两把锁
    keys.push('file:' + abs.split(path.sep).join('/'));
  };
  const tool = String(name || '');
  if (tool === 'write_file' || tool === 'edit_file') {
    pushFile(a.path || a.filePath || a.file);
  } else if (tool === 'bulk_edit') {
    for (const item of Array.isArray(a.edits) ? a.edits : []) pushFile(item && (item.path || item.filePath));
    for (const item of Array.isArray(a.files) ? a.files : []) pushFile(item && (item.path || item.filePath));
    if (!keys.length) pushFile(a.path || a.filePath);
  } else if (tool === 'write_analysis_md') {
    pushFile(a.path || a.filePath);
  } else if (tool === 'save_project') {
    keys.push(PROJECT_SAVE_KEY);
  } else if (tool === 'workbench_edit' || tool === 'ui_control' || tool === 'create_nodes' || tool === 'workbench_connect') {
    // 画布是**单一资源**：两个 Agent 同时改画布一定互相覆盖，不存在「改不同节点就没事」
    keys.push(CANVAS_KEY);
  }
  return [...new Set(keys)];
}

class LeaseRegistry {
  /**
   * @param {{ttlMs?: number, enabled?: boolean, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    this.enabled = options.enabled !== false;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** @type {Map<string, {holder: string, role: string, acquiredAt: number, expiresAt: number, renewals: number}>} */
    this.leases = new Map();
    /** 发生过多少次「被别人占着」的冲突（可观测：为 0 说明这层没起作用） */
    this.conflicts = 0;
    this.acquired = 0;
  }

  /** 清掉过期租约（持有者崩溃/取消时的兜底） */
  sweep() {
    const now = this.now();
    const expired = [];
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(key);
        expired.push({ key, holder: lease.holder });
      }
    }
    return expired;
  }

  /** 只读查询：谁占着（含是否过期判断，不改状态） */
  holder(key) {
    const lease = this.leases.get(String(key));
    if (!lease) return null;
    if (lease.expiresAt <= this.now()) return null;
    return { key: String(key), ...lease };
  }

  /**
   * **原子**申请一组资源键：要么全部拿到、要么一个都不占。
   * 同一持有者重复申请 = 续期（不算冲突）。
   * @param {string[]} keys
   * @param {string} holder 持有者标识（子代理用 taskId，主代理用 'supervisor'）
   * @param {{role?: string, ttlMs?: number}} [meta]
   * @returns {{ok: boolean, granted: string[], conflict: {key: string, holder: string, role: string, expiresAt: number}|null}}
   */
  acquire(keys, holder, meta = {}) {
    const list = [...new Set((Array.isArray(keys) ? keys : []).filter(Boolean))];
    if (!this.enabled || !list.length) return { ok: true, granted: [], conflict: null };
    this.sweep();
    const who = String(holder || 'supervisor');
    for (const key of list) {
      const current = this.holder(key);
      if (current && current.holder !== who) {
        this.conflicts += 1;
        return { ok: false, granted: [], conflict: current };
      }
    }
    const ttl = Number(meta.ttlMs) > 0 ? Number(meta.ttlMs) : this.ttlMs;
    const now = this.now();
    for (const key of list) {
      const existing = this.leases.get(key);
      const renewals = existing && existing.holder === who ? existing.renewals : 0;
      this.leases.set(key, {
        holder: who,
        role: String(meta.role || (existing && existing.role) || ''),
        acquiredAt: existing && existing.holder === who ? existing.acquiredAt : now,
        expiresAt: now + ttl,
        renewals,
      });
      this.acquired += 1;
    }
    return { ok: true, granted: list, conflict: null };
  }

  /** 释放（只有持有者能释放；别人的释放请求是 no-op，防误放） */
  release(keys, holder) {
    const who = String(holder || 'supervisor');
    let released = 0;
    for (const key of Array.isArray(keys) ? keys : []) {
      const lease = this.leases.get(String(key));
      if (lease && lease.holder === who) {
        this.leases.delete(String(key));
        released += 1;
      }
    }
    return released;
  }

  /** 任务结束时一次释放该持有者的全部租约（子代理完成/失败/取消都要调） */
  releaseAll(holder) {
    const who = String(holder || '');
    let released = 0;
    for (const [key, lease] of [...this.leases]) {
      if (lease.holder === who) {
        this.leases.delete(key);
        released += 1;
      }
    }
    return released;
  }

  /** 某持有者当前占着哪些（用例/诊断用） */
  held(holder) {
    const who = String(holder || '');
    return [...this.leases.entries()].filter(([, lease]) => lease.holder === who).map(([key]) => key);
  }

  /** 可观测状态（trace/用例断言用） */
  snapshot() {
    return {
      enabled: this.enabled,
      ttlMs: this.ttlMs,
      counters: { acquired: this.acquired, conflicts: this.conflicts },
      held: [...this.leases.entries()].map(([key, lease]) => ({ key, ...lease })),
    };
  }
}

module.exports = { LeaseRegistry, resourceKeysFor, DEFAULT_TTL_MS, CANVAS_KEY, PROJECT_SAVE_KEY };
