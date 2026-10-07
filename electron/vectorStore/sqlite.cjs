/**
 * 本地持久化向量后端：node:sqlite + sqlite-vec。仅显式配置 rag.vector_store=sqlite 时加载。
 * chunk 文本不写入向量库；主键、文件、内容哈希与向量保存在工程 .codenode 下。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BATCH_SIZE = 32;
const FILE_BATCH_SIZE = 500;

function vectorBlob(vector, dim) {
  if (!Array.isArray(vector) || vector.length !== dim || !vector.every(Number.isFinite)) {
    throw new Error('SQLite 向量维度或数值无效：期望 ' + dim + ' 维');
  }
  return new Uint8Array(new Float32Array(vector).buffer);
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function databaseName(options) {
  const identity = JSON.stringify({
    schema: 1,
    provider: options.provider || 'local', model: options.model || '', base: options.base || '',
    dimensions: options.dimensions || '', dim: options.dim,
    queryPrefix: options.queryPrefix || '', documentPrefix: options.documentPrefix || '',
  });
  return 'rag-vectors-' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12) + '.sqlite';
}

class SqliteVectorStore {
  constructor(options) {
    const o = options || {};
    this.kind = 'sqlite';
    this.prefiltered = false;
    this.root = path.resolve(o.root || '.');
    this.dim = Math.floor(Number(o.dim) || 4096);
    this.searchLimit = Math.max(1, Math.min(4096, Math.floor(Number(o.topK) || 40)));
    this.file = path.join(this.root, '.codenode', databaseName({
      provider: o.provider, model: o.model, base: o.base, dimensions: o.dimensions, dim: this.dim,
      queryPrefix: o.queryPrefix, documentPrefix: o.documentPrefix,
    }));
    this.db = null;
    this.reconciled = false;
    this.counters = { inserted: 0, deleted: 0, reused: 0, searches: 0, batches: 0 };
  }

  ensureDb() {
    if (this.db) return this.db;
    let DatabaseSync;
    let sqliteVec;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
      const extension = 'sqlite-vec';
      sqliteVec = require(extension);
    } catch (error) {
      throw new Error('SQLite 向量后端需要 Node/Electron 的 node:sqlite 与 sqlite-vec 0.1.9；安装：npm i sqlite-vec@0.1.9（' +
        ((error && error.message) || error) + '）');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file, { allowExtension: true, timeout: 5000 });
    try {
      const extensionPath = sqliteVec.getLoadablePath().replace(/\.asar(?=[\\/])/, '.asar.unpacked');
      db.loadExtension(extensionPath);
      db.enableLoadExtension(false);
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('CREATE TABLE IF NOT EXISTS rag_chunks (rid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE, file TEXT NOT NULL, hash TEXT NOT NULL)');
      db.exec('CREATE INDEX IF NOT EXISTS rag_chunks_file ON rag_chunks(file)');
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS rag_vectors USING vec0(embedding float[' + this.dim + '] distance_metric=cosine, file text)');
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='rag_vectors'").get();
      if (!schema || !String(schema.sql).includes('float[' + this.dim + ']')) {
        throw new Error('SQLite 向量库维度与 rag.embed_dim 不一致：' + this.file);
      }
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  dropLocal() { return 0; }
  async chunkVector() { return null; }

  /** 首次打开时用完整块清单清除上次会话留下的已删文件；截断扫描不执行清理。 */
  reconcile(db, activeIds) {
    if (this.reconciled || !Array.isArray(activeIds)) return 0;
    const active = new Set(activeIds);
    const stale = db.prepare('SELECT rid, chunk_id FROM rag_chunks').all().filter((row) => !active.has(row.chunk_id));
    const delVec = db.prepare('DELETE FROM rag_vectors WHERE rowid=?');
    const delChunk = db.prepare('DELETE FROM rag_chunks WHERE rid=?');
    for (const row of stale) {
      delVec.run(BigInt(row.rid));
      delChunk.run(row.rid);
    }
    this.reconciled = true;
    return stale.length;
  }

  async applyChanges(change, embedder) {
    const db = this.ensureDb();
    const deleted = new Set((change && change.deleted || []).map((item) => item.relative).filter(Boolean));
    const upserted = [...new Map((change && change.upserted || [])
      .filter((item) => item && item.id && item.path && typeof item.text === 'string')
      .map((item) => [item.id, item])).values()];
    const find = db.prepare('SELECT rid, hash FROM rag_chunks WHERE chunk_id=?');
    const fresh = [];
    let reused = 0;
    for (const item of upserted) {
      const hash = contentHash(item.text);
      const prior = find.get(item.id);
      if (prior && prior.hash === hash && !deleted.has(item.path)) {
        reused++;
        continue;
      }
      fresh.push({ ...item, hash, vector: null });
    }
    for (let start = 0; start < fresh.length; start += BATCH_SIZE) {
      if (!embedder) throw new Error('SQLite 向量写入需要嵌入提供方');
      const batch = fresh.slice(start, start + BATCH_SIZE);
      const vectors = await embedder.embed(batch.map((item) => item.text), { inputType: 'document' });
      if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error('SQLite 嵌入返回数量与请求不一致');
      for (let i = 0; i < batch.length; i++) batch[i].vector = vectorBlob(vectors[i], this.dim);
      this.counters.batches++;
    }
    let removed = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      removed += this.reconcile(db, change && change.activeIds);
      const byFile = db.prepare('SELECT rid FROM rag_chunks WHERE file=?');
      const delVec = db.prepare('DELETE FROM rag_vectors WHERE rowid=?');
      const delChunk = db.prepare('DELETE FROM rag_chunks WHERE rid=?');
      const insertChunk = db.prepare('INSERT INTO rag_chunks(chunk_id,file,hash) VALUES (?,?,?)');
      const insertVec = db.prepare('INSERT INTO rag_vectors(rowid,embedding,file) VALUES (?,?,?)');
      for (const file of deleted) {
        for (const row of byFile.all(file)) {
          delVec.run(BigInt(Number(row.rid)));
          delChunk.run(row.rid);
          removed++;
        }
      }
      for (const item of fresh) {
        const prior = find.get(item.id);
        if (prior) {
          delVec.run(BigInt(Number(prior.rid)));
          delChunk.run(prior.rid);
          removed++;
        }
        const inserted = insertChunk.run(item.id, item.path, item.hash);
        insertVec.run(BigInt(inserted.lastInsertRowid), item.vector, item.path);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      this.reconciled = false;
      throw error;
    }
    this.counters.inserted += fresh.length;
    this.counters.deleted += removed;
    this.counters.reused += reused;
    return { backend: this.kind, inserted: fresh.length, deleted: removed, reused, file: this.file };
  }

  async scoreCandidates(query, candidates, embedder, options) {
    void candidates;
    const out = new Map();
    if (!embedder) return out;
    const db = this.ensureDb();
    const [vector] = await embedder.embed([query], { inputType: 'query' });
    const blob = vectorBlob(vector, this.dim);
    const files = options && Array.isArray(options.files) ? [...new Set(options.files)] : null;
    if (files && !files.length) return out;
    /** @type {(string[]|null)[]} */
    const filters = files ? [] : [null];
    if (files) {
      for (let start = 0; start < files.length; start += FILE_BATCH_SIZE) filters.push(files.slice(start, start + FILE_BATCH_SIZE));
    }
    const lookup = db.prepare('SELECT chunk_id FROM rag_chunks WHERE rid=?');
    for (const batch of filters) {
      const placeholders = batch ? ' AND file IN (' + batch.map(() => '?').join(',') + ')' : '';
      const sql = 'SELECT rowid, distance FROM rag_vectors WHERE embedding MATCH ?' + placeholders +
        ' AND k=? ORDER BY distance';
      const args = batch ? [blob, ...batch, this.searchLimit] : [blob, this.searchLimit];
      for (const hit of db.prepare(sql).all(...args)) {
        const row = lookup.get(hit.rowid);
        if (!row) continue;
        const score = Math.max(0, Math.min(1, 1 - Number(hit.distance)));
        out.set(row.chunk_id, Math.max(out.get(row.chunk_id) || 0, score));
      }
      this.counters.searches++;
    }
    return out;
  }

  async stats() {
    const db = this.ensureDb();
    return {
      backend: this.kind, external: false, persisted: true, file: this.file,
      vectors: Number(db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get()?.n || 0),
      ...this.counters,
    };
  }

  async close() {
    if (this.db) this.db.close();
    this.db = null;
  }
}

function createSqliteVectorStore(options) { return new SqliteVectorStore(options); }

module.exports = { SqliteVectorStore, createSqliteVectorStore };
