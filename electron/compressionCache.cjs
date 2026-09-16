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

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

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
   * @param {{projectRoot?: string|null, maxEntries?: number, maxBytes?: number, file?: string|null}} [options]
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
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of parsed.entries || []) {
        if (!item || typeof item.value !== 'string' || !item.key) continue;
        this.entries.set(item.key, item);
        this.bytes += Buffer.byteLength(item.value, 'utf8');
      }
    } catch {
      // 缓存损坏：忽略即可（最坏是重新压一次），但把原因留下供排查，不静默
      this.loadError = '压缩缓存解析失败，已忽略旧内容';
    }
  }

  _persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteFile(this.file, JSON.stringify({ updatedAt: new Date().toISOString(), entries: [...this.entries.values()] }));
    } catch {
      // 落盘失败不影响本次返回：内存缓存仍然有效
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
    const item = { key, tool: String(toolName || ''), value, ts: new Date().toISOString() };
    this.entries.set(key, item);
    this.bytes += Buffer.byteLength(value, 'utf8');
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next();
      if (oldestKey.done) break;
      const oldest = this.entries.get(oldestKey.value);
      this.entries.delete(oldestKey.value);
      if (oldest) this.bytes -= Buffer.byteLength(oldest.value, 'utf8');
      if (this.entries.size <= 0) break;
    }
    this._persist();
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
    };
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this._persist();
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

/** 测试用：清空进程内实例。 */
function resetCompressionCaches() {
  instances.clear();
}

module.exports = {
  CompressionCache,
  getCompressionCache,
  resetCompressionCaches,
  compressionKey,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_BYTES,
};
