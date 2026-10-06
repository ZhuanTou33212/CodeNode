/**
 * compressionCache.cjs —— 工具结果压缩的**内容级缓存**（S9 附带，2026-09-16）
 *
 * 问题（用户实测反馈 + 读码确认）：每次工具结果压缩都是一次**几乎全新的 prefill**。
 * 压缩请求的形状是「固定 system 提示 + 这一次工具结果的原文」，服务端前缀缓存只能命中
 * 前面那几百 token 的 system，占绝对多数的 user 段每次都不同 —— 所以那次压缩调用的
 * 缓存命中率天然极低，等于把一份大原文再算一遍输入。
 *
 * 既然同一份原文可能被反复压缩（重复调用、断点续跑、同一文件被多次读取），最省的做法是
 * 在本地做**内容级缓存**：
 *   key = sha256(工具名 + 目标预算 + 原文) → 摘要
 * 命中即复用：零 token、零延迟，也不占用上下文。落盘位置
 * `<projectRoot>/.codenode/metrics/compression-cache.json`（LRU，默认 200 条 / 2MB）。
 *
 * 说明：本模块只负责「同内容不重复付钱」。真正提升服务端前缀命中率要靠请求前缀稳定
 * （compressorSystemPrompt 现在是常量，不再把预算数字拼进 system），以及把同一轮多个
 * 超大结果合并成一次压缩请求（尚未做，见 docs 实施记录）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { redact } = require('./redaction.cjs');

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * #13：落盘合并窗口（ms）。`set()` 只打脏标记 + 记字节数；攒到一个窗口（或显式 flush /
 * 进程退出）才写一次盘。旧实现每 `set` 一条就把整个缓存（最多 200 条 / 2MB）JSON.stringify
 * + fsync + rename 重写一次 —— 一轮里压缩几十份结果就是几十次全量重写，全在同步路径上。
 */
const DEFAULT_FLUSH_DELAY_MS = 250;

/**
 * #15：与 runStore 同一脱敏口径。缓存的值是「工具结果的模型摘要」，工具结果里可能带密钥，
 * 落盘前必须过一遍 `redact`。只改正文里的密钥样式文本，条目结构 / 字节统计口径不变。
 */
function safeValue(value) {
  return typeof value === 'string' ? redact(value) : value;
}

/** 进程内「攒着还没落盘」的实例（#13）：退出 / 显式 flush 时统一保证落盘。 */
const dirtyInstances = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 缓存本身可重建（丢了最坏是重新压一次），但「已经压过的摘要」不该因为退出就丢：
  // 退出前把脏实例写掉。写失败只能吞掉 —— 进程正在退出，没有补救通道。
  process.on('exit', () => {
    try { flushPendingCaches(); } catch { /* ignore */ }
  });
}

/** 把某个文件的其它脏实例先落盘（保证「新实例读到的就是最新内容」）。 */
function flushInstancesFor(file, exclude) {
  if (!file) return 0;
  const target = path.resolve(file);
  let writes = 0;
  for (const cache of [...dirtyInstances]) {
    if (cache === exclude) continue;
    if (cache.file && path.resolve(cache.file) === target && cache.flush()) writes += 1;
  }
  return writes;
}

/** 把所有脏实例落盘（进程退出 / 测试 / 显式调用）。返回实际写盘次数。 */
function flushPendingCaches() {
  let writes = 0;
  for (const cache of [...dirtyInstances]) {
    if (cache.flush()) writes += 1;
  }
  return writes;
}

/**
 * 内容级缓存键：工具名 + 目标预算 + 原文。
 * @param {string} toolName
 * @param {number|string} budgetChars
 * @param {string} text
 * @returns {string}
 */
function compressionKey(toolName, budgetChars, text) {
  return crypto
    .createHash('sha256')
    .update(String(toolName || '') + '\u0000' + String(budgetChars || '') + '\u0000' + String(text || ''))
    .digest('hex')
    .slice(0, 32);
}

class CompressionCache {
  /**
   * @param {{projectRoot?: string|null, maxEntries?: number, maxBytes?: number, file?: string|null,
   *          flushDelayMs?: number}} [options]
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || null;
    this.maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
    this.maxBytes = Math.max(16 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
    this.file =
      options.file !== undefined
        ? options.file
        : this.projectRoot
          ? path.join(path.resolve(this.projectRoot), '.codenode', 'metrics', 'compression-cache.json')
          : null;
    /** @type {Map<string, {key: string, tool: string, value: string, ts: string}>} 插入序 = LRU 序 */
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.bytes = 0;
    this.loadError = null;
    /** #13：脏标记 + 合并落盘计数（writes = 真实写盘次数，供测试/运维核对） */
    this.dirty = false;
    this.writes = 0;
    this.timer = null;
    this.flushDelayMs = Number.isFinite(Number(options.flushDelayMs))
      ? Math.max(0, Number(options.flushDelayMs))
      : DEFAULT_FLUSH_DELAY_MS;
    this.lastPersistError = null;
    this._load();
  }

  _load() {
    // 同一文件可能有别的实例攒着没落盘（例如压缩缓存是进程内单例，但测试/多处会 new）：
    // 读之前先把它们刷掉，保证「新实例能看到最新内容」。
    flushInstancesFor(this.file, this);
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of parsed.entries || []) {
        if (!item || typeof item.value !== 'string' || !item.key) continue;
        // #15：旧文件可能是明文写下的，读回时同样过一遍脱敏（防御性）
        const value = safeValue(item.value);
        this.entries.set(item.key, { ...item, value });
        this.bytes += Buffer.byteLength(value, 'utf8');
      }
    } catch {
      // 缓存损坏：忽略即可（最坏是重新压一次），但把原因留下供排查，不静默
      this.loadError = '压缩缓存解析失败，已忽略旧内容';
    }
  }

  /** #13：打脏标记并安排一次延迟落盘（同一窗口内的多次 set 合并成一次写盘）。 */
  _markDirty() {
    if (!this.file) return; // 无落盘目标：内存缓存即可
    this.dirty = true;
    dirtyInstances.add(this);
    installExitHook();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelayMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * #13：显式落盘 —— 脏才写，一次写完整个缓存（合并窗口内的所有 set）。
   * @returns {boolean} 是否真的写了盘
   */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) {
      dirtyInstances.delete(this);
      return false;
    }
    this.dirty = false;
    dirtyInstances.delete(this);
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteFile(this.file, JSON.stringify({ updatedAt: new Date().toISOString(), entries: [...this.entries.values()] }));
      this.writes += 1;
      this.lastPersistError = null;
      return true;
    } catch (error) {
      // 落盘失败不影响本次返回：内存缓存仍然有效；保持脏，下次 set / flush / 退出时再试
      this.lastPersistError = String((error && error.message) || error);
      this.dirty = true;
      dirtyInstances.add(this);
      return false;
    }
  }

  /**
   * 取缓存（命中会把条目移到 LRU 尾部）。
   * @param {string} key
   * @returns {string|null}
   */
  get(key) {
    const hit = this.entries.get(key);
    if (!hit) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  /**
   * 写缓存（超限淘汰最旧条目）。
   * @param {string} key
   * @param {string} value
   * @param {string} [toolName]
   */
  set(key, value, toolName) {
    if (!key || typeof value !== 'string' || !value) return null;
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= Buffer.byteLength(existing.value, 'utf8');
      this.entries.delete(key);
    }
    const item = { key, tool: String(toolName || ''), value: safeValue(value), ts: new Date().toISOString() };
    this.entries.set(key, item);
    this.bytes += Buffer.byteLength(item.value, 'utf8');
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next();
      if (oldestKey.done) break;
      const oldest = this.entries.get(oldestKey.value);
      this.entries.delete(oldestKey.value);
      if (oldest) this.bytes -= Buffer.byteLength(oldest.value, 'utf8');
    }
    this._markDirty(); // #13：只打脏标记，合并到一次落盘（不再每条全量重写 + fsync）
    return item;
  }

  /** 命中率等指标（供测试 / 成本报表核对：命中一次就是省下一次完整 prefill 的钱）。 */
  stats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      bytes: this.bytes,
      hitRate: total ? Number((this.hits / total).toFixed(4)) : 0,
      file: this.file,
      loadError: this.loadError,
      // #13：脏标记与真实写盘次数 —— 「合并落盘」是可核对的，不是口头承诺
      dirty: this.dirty,
      writes: this.writes,
      lastPersistError: this.lastPersistError,
    };
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this._markDirty();
  }
}

/** @type {Map<string, CompressionCache>} 进程内单例（按项目根），避免每次压缩都读写磁盘 */
const instances = new Map();

/**
 * 取项目级压缩缓存（无 projectRoot 时用全局实例）。
 * @param {string|null} [projectRoot]
 * @param {{maxEntries?: number, maxBytes?: number, file?: string|null}} [options]
 * @returns {CompressionCache}
 */
function getCompressionCache(projectRoot, options) {
  const key = projectRoot ? path.resolve(projectRoot) : '__global__';
  const existing = instances.get(key);
  if (existing) return existing;
  const cache = new CompressionCache({ projectRoot: projectRoot || null, ...(options || {}) });
  instances.set(key, cache);
  return cache;
}

/**
 * 测试用：清空进程内实例。**丢弃待落盘缓冲**（不写盘）—— 用例会在断言后删临时目录，
 * 若保留脏实例，退出兜底会往已删除的目录里重新 mkdir + 写文件。
 */
function resetCompressionCaches() {
  for (const cache of [...dirtyInstances]) {
    if (cache.timer) {
      clearTimeout(cache.timer);
      cache.timer = null;
    }
    cache.dirty = false;
  }
  dirtyInstances.clear();
  instances.clear();
}

module.exports = {
  CompressionCache,
  getCompressionCache,
  resetCompressionCaches,
  flushPendingCaches,
  compressionKey,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_BYTES,
  DEFAULT_FLUSH_DELAY_MS,
};
