'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { DEFAULTS, clearIndexCache } = require('./rag/index.cjs');

const KEYS = {
  provider: 'rag.embed_provider',
  model: 'rag.embed_model',
  base: 'rag.embed_base',
  dim: 'rag.embed_dim',
  dimensions: 'rag.embed_dimensions',
  backend: 'rag.vector_store',
  key: 'rag.embed_key',
  bm25K1: 'rag.bm25_k1',
  bm25B: 'rag.bm25_b',
  vectorWeight: 'rag.vector_weight',
};

function publicSettings(rag) {
  return {
    provider: rag.embedProvider,
    model: rag.embedModel,
    base: rag.embedBase,
    dim: rag.embedDim,
    dimensions: rag.embedDimensions,
    backend: rag.vectorStore,
    bm25K1: rag.bm25K1,
    bm25B: rag.bm25B,
    vectorWeight: rag.vectorWeight,
    hasKey: !!rag.embedKey,
    rerankEnabled: !!rag.rerankUrl,
    rerankExternal: !!rag.rerankUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(rag.rerankUrl),
  };
}

function normalizedSettings(raw, existing) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!['none', 'local', 'ollama', 'openai'].includes(provider)) throw new Error('嵌入提供方必须是 none、local、ollama 或 openai');
  const backend = String(input.backend || '').trim().toLowerCase();
  if (!['memory', 'sqlite'].includes(backend)) throw new Error('设置页仅支持 memory 或 sqlite；Milvus 请在配置文件中单独配置');
  const dim = Number(input.dim);
  if (!Number.isInteger(dim) || dim < 256 || dim > 8192) throw new Error('向量维度必须在 256–8192 之间');
  const bm25K1 = Number(input.bm25K1 == null ? existing.bm25K1 ?? DEFAULTS.bm25K1 : input.bm25K1);
  const bm25B = Number(input.bm25B == null ? existing.bm25B ?? DEFAULTS.bm25B : input.bm25B);
  const vectorWeight = Number(input.vectorWeight == null ? existing.vectorWeight ?? DEFAULTS.vectorWeight : input.vectorWeight);
  if (!Number.isFinite(bm25K1) || bm25K1 < 0.1 || bm25K1 > 3) throw new Error('BM25 k1 必须在 0.1–3 之间');
  if (!Number.isFinite(bm25B) || bm25B < 0 || bm25B > 1) throw new Error('BM25 b 必须在 0–1 之间');
  if (!Number.isFinite(vectorWeight) || vectorWeight < 0 || vectorWeight > 1) throw new Error('向量融合权重必须在 0–1 之间');
  const dimensions = input.dimensions == null || String(input.dimensions).trim() === '' ? '' : String(input.dimensions).trim();
  if (dimensions && (!/^\d+$/.test(dimensions) || Number(dimensions) !== dim)) throw new Error('请求维度必须与索引维度一致');
  const model = String(input.model || '').trim();
  const base = String(input.base || '').trim().replace(/\/+$/, '');
  const key = String(input.key || '').trim() || String(existing.embedKey || '');
  if (provider === 'ollama' || provider === 'openai') {
    if (!model) throw new Error('语义模式需要填写嵌入模型');
    let url;
    try { url = new URL(base); } catch { throw new Error('嵌入服务地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('嵌入服务地址须为不含账号密码的 HTTP(S) 地址');
    if (provider === 'openai' && !key) throw new Error('OpenAI 兼容嵌入服务需要 API Key');
  }
  for (const value of [model, base, key]) if (/[\r\n]/.test(value)) throw new Error('配置值不能包含换行');
  return { provider, backend: provider === 'none' ? 'memory' : backend, dim, dimensions: provider === 'openai' ? dimensions : '', model: provider === 'ollama' || provider === 'openai' ? model : '', base: provider === 'ollama' || provider === 'openai' ? base : '', key, bm25K1, bm25B, vectorWeight };
}

async function checkSettings(settings) {
  if (settings.backend === 'sqlite') {
    try { require('node:sqlite'); require('sqlite-vec'); }
    catch (error) { return { ok: false, error: 'SQLite 向量后端不可用：' + String(error && error.message || error).slice(0, 180) }; }
  }
  if (settings.provider === 'local' || settings.provider === 'none') return { ok: true, dimension: settings.dim, mode: settings.provider };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = settings.base + (settings.provider === 'ollama' ? '/api/embeddings' : '/embeddings');
    const body = settings.provider === 'ollama'
      ? { model: settings.model, prompt: 'CodeNode 检索配置测试' }
      : { model: settings.model, input: ['CodeNode 检索配置测试'], ...(settings.dimensions ? { dimensions: Number(settings.dimensions) } : {}) };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(settings.provider === 'openai' ? { Authorization: 'Bearer ' + settings.key } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: '嵌入端点 HTTP ' + response.status + '：' + (await response.text()).slice(0, 180) };
    /** @type {any} */
    const data = await response.json();
    const vector = settings.provider === 'ollama' ? data.embedding : data.data && data.data[0] && data.data[0].embedding;
    if (!Array.isArray(vector) || !vector.every(Number.isFinite)) return { ok: false, error: '嵌入端点未返回有效向量' };
    if (vector.length !== settings.dim) return { ok: false, error: '模型实际返回 ' + vector.length + ' 维，与设置的 ' + settings.dim + ' 维不一致' };
    return { ok: true, dimension: vector.length, mode: 'semantic' };
  } catch (error) {
    return { ok: false, error: '嵌入端点不可达：' + String(error && error.message || error).slice(0, 180) };
  } finally { clearTimeout(timer); }
}

function writeSettings(projectRoot, settings, previous) {
  const root = path.resolve(projectRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('项目目录不存在');
  const file = path.join(root, '.codenode', 'agent.properties');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const entries = new Map([
    [KEYS.provider, settings.provider], [KEYS.model, settings.model], [KEYS.base, settings.base],
    [KEYS.dim, String(settings.dim)], [KEYS.dimensions, settings.dimensions], [KEYS.backend, settings.backend],
    [KEYS.bm25K1, String(settings.bm25K1)], [KEYS.bm25B, String(settings.bm25B)],
    [KEYS.vectorWeight, String(settings.vectorWeight)],
  ]);
  if (settings.key && settings.key !== previous.embedKey) entries.set(KEYS.key, settings.key);
  const lines = before.split(/\r?\n/).filter((line) => {
    const match = /^\s*([^#!\s][^=]*)=/.exec(line);
    return !match || !entries.has(match[1].trim());
  });
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  lines.push('# CodeNode RAG 设置', ...[...entries].map(([key, value]) => key + '=' + value));
  atomicWriteFile(file, lines.join('\n') + '\n');
  clearIndexCache();
  return { ok: true, rebuildRequired: true };
}

module.exports = { publicSettings, normalizedSettings, checkSettings, writeSettings };
