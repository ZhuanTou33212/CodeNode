/**
 * CodeNode 本地 Agentic RAG 索引。
 *
 * - 默认零网络、零外部服务；向量层可选接入 Milvus（rag.vector_store=milvus，显式配置才启用）；
 * - 文件级增量缓存与显式失效；
 * - BM25 + 路径/短语/覆盖率加权；
 * - 多查询 Reciprocal Rank Fusion；
 * - 行号来源、相关性诊断与敏感文件硬排除。
 *
 * 向量层通过 electron/vectorStore 的可插拔后端实现（memory 默认 / sqlite 本地持久化 / milvus 外部 ANN）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { shouldSkipDir, isBinaryFileName } = require('../tools/toolFiles.cjs');
const { globToRegExp } = require('../tools/impl/shared.cjs');
const { createEmbedder, cosine } = require('../embedder/index.cjs');
const { createVectorStore, normalizeBackend } = require('../vectorStore/index.cjs');
const { buildCodeGraph } = require('./codeGraph.cjs');
const { rerankCandidates } = require('./rerank.cjs');
const { isDocumentFile, extractDocumentText } = require('../tools/impl/documentText.cjs');

const DEFAULTS = Object.freeze({
  enabled: true,
  maxFiles: 5000,
  maxFileBytes: 512 * 1024,
  maxDocumentBytes: 20 * 1024 * 1024,
  chunkLines: 72,
  chunkOverlap: 12,
  topK: 6,
  maxContextChars: 12000,
  maxQueries: 5,
  graphHops: 1,
  bm25K1: 1.35,
  bm25B: 0.72,
  rerankUrl: '',
  rerankModel: '',
  rerankKey: '',
  rerankTopK: 24,
  rerankTimeoutMs: 10000,
  minCoverage: 0.2,
  include: [],
  exclude: [],
  embedProvider: 'none',
  embedDim: 4096,
  embedModel: '',
  embedBase: '',
  embedKey: '',
  embedTopK: 40,
  memorySemanticMaxChunks: 128,
  vectorWeight: 0.35,
  vectorStore: 'memory',
  milvusAddress: '',
  milvusToken: '',
  milvusUsername: '',
  milvusPassword: '',
  milvusCollection: '',
});

/** 纯语义命中（BM25 未召回、仅由向量后端带回）并入结果的最小 rankScore 贡献，避免灌入无关行。 */
const VECTOR_ONLY_MIN_CONTRIBUTION = 1;
/** 纯向量命中达到此分数时仅视作值得深读的候选，不代表内容足以支持答案。 */
const SEMANTIC_CANDIDATE_MIN_SCORE = 0.4;
const PARENT_CONTEXT_CHARS = 500;
const CODE_FILE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

const EXTRA_IGNORED_DIRS = new Set([
  '.codenode',
  '.cache',
  '.obsidian',
  '.turbo',
  '.parcel-cache',
  '.pytest_cache',
]);

const NOISY_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'cargo.lock',
]);

const SENSITIVE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'agent.properties',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.der',
]);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on',
  'or', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'why', 'with',
  '一个', '什么', '如何', '怎么', '为什么', '是否', '这个', '那个', '以及', '进行', '相关',
]);

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizePatterns(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((item) => String(item).trim().replace(/\\/g, '/')).filter(Boolean))].slice(0, 50);
}

function normalizeOptions(options) {
  const o = options || {};
  const chunkLines = clampInteger(o.chunkLines, DEFAULTS.chunkLines, 8, 400);
  return {
    enabled: o.enabled !== false,
    maxFiles: clampInteger(o.maxFiles, DEFAULTS.maxFiles, 1, 50000),
    maxFileBytes: clampInteger(o.maxFileBytes, DEFAULTS.maxFileBytes, 1024, 8 * 1024 * 1024),
    maxDocumentBytes: clampInteger(o.maxDocumentBytes, DEFAULTS.maxDocumentBytes, 1024 * 1024, 100 * 1024 * 1024),
    chunkLines,
    chunkOverlap: clampInteger(o.chunkOverlap, DEFAULTS.chunkOverlap, 0, Math.max(0, chunkLines - 1)),
    topK: clampInteger(o.topK, DEFAULTS.topK, 1, 20),
    maxContextChars: clampInteger(o.maxContextChars, DEFAULTS.maxContextChars, 1000, 50000),
    maxQueries: clampInteger(o.maxQueries, DEFAULTS.maxQueries, 1, 8),
    graphHops: clampInteger(o.graphHops, DEFAULTS.graphHops, 0, 2),
    bm25K1: clampNumber(o.bm25K1, DEFAULTS.bm25K1, 0.1, 3),
    bm25B: clampNumber(o.bm25B, DEFAULTS.bm25B, 0, 1),
    rerankUrl: String(o.rerankUrl || '').trim(),
    rerankModel: String(o.rerankModel || '').trim(),
    rerankKey: String(o.rerankKey || '').trim(),
    rerankTopK: clampInteger(o.rerankTopK, DEFAULTS.rerankTopK, 4, 40),
    rerankTimeoutMs: clampInteger(o.rerankTimeoutMs, DEFAULTS.rerankTimeoutMs, 1000, 60000),
    rerankClient: typeof o.rerankClient === 'function' ? o.rerankClient : null,
    minCoverage: clampNumber(o.minCoverage, DEFAULTS.minCoverage, 0.05, 1),
    include: normalizePatterns(o.include),
    exclude: normalizePatterns(o.exclude),
    embedProvider: String(o.embedProvider || DEFAULTS.embedProvider).toLowerCase().trim(),
    embedDim: clampInteger(o.embedDim, DEFAULTS.embedDim, 256, 8192),
    embedModel: String(o.embedModel || '').trim(),
    embedBase: String(o.embedBase || '').trim(),
    embedKey: String(o.embedKey || '').trim(),
    embedDimensions: String(o.embedDimensions || '').trim(),
    embedTopK: clampInteger(o.embedTopK, DEFAULTS.embedTopK, 5, 500),
    memorySemanticMaxChunks: clampInteger(o.memorySemanticMaxChunks, DEFAULTS.memorySemanticMaxChunks, 0, 5000),
    vectorWeight: clampNumber(o.vectorWeight, DEFAULTS.vectorWeight, 0, 1),
    vectorStore: normalizeBackend(o.vectorStore),
    milvusAddress: String(o.milvusAddress || '').trim(),
    milvusToken: String(o.milvusToken || '').trim(),
    milvusUsername: String(o.milvusUsername || '').trim(),
    milvusPassword: String(o.milvusPassword || '').trim(),
    milvusCollection: String(o.milvusCollection || '').trim(),
    milvusConsistency: String(o.milvusConsistency || 'strong').trim(),
    // Milvus 索引/检索/写入参数（生产档：HNSW + 1024 维 + 大批量）
    milvusIndexType: String(o.milvusIndexType || 'HNSW').trim(),
    milvusMetricType: String(o.milvusMetricType || 'COSINE').trim(),
    milvusIndexM: clampInteger(o.milvusIndexM, 16, 4, 2048),
    milvusIndexEfConstruction: clampInteger(o.milvusIndexEfConstruction, 200, 8, 4096),
    milvusSearchEf: clampInteger(o.milvusSearchEf, 64, 8, 16384),
    milvusBatchSize: clampInteger(o.milvusBatchSize, 128, 1, 1024),
    milvusFlushEvery: clampInteger(o.milvusFlushEvery, 4, 1, 1000),
    // 仅供测试注入向量后端客户端（真实运行时不使用）
    vectorStoreClient: o.vectorStoreClient || null,
  };
}

function compilePatterns(patterns) {
  return patterns.map((pattern) => {
    try {
      return { pattern, regex: globToRegExp(pattern) };
    } catch (error) {
      throw new Error('无效 RAG glob：' + pattern + '（' + ((error && error.message) || error) + '）');
    }
  });
}

function isSensitiveFile(relative) {
  const normalized = relative.replace(/\\/g, '/').toLowerCase();
  const name = path.posix.basename(normalized);
  const ext = path.posix.extname(name);
  if (SENSITIVE_NAMES.has(name) || name.startsWith('.env.')) return true;
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;
  return /(^|[._-])(credentials?|secrets?|private[-_]?key)([._-]|$)/i.test(name);
}

function shouldIndexFile(relative, size, maxFileBytes, maxDocumentBytes = DEFAULTS.maxDocumentBytes) {
  const normalized = relative.replace(/\\/g, '/');
  const name = path.posix.basename(normalized).toLowerCase();
  const document = isDocumentFile(name);
  if (!size || size > (document ? maxDocumentBytes : maxFileBytes)) return false;
  if ((!document && isBinaryFileName(name)) || isSensitiveFile(normalized) || NOISY_FILES.has(name)) return false;
  if (name.endsWith('.min.js') || name.endsWith('.min.css') || name.endsWith('.map')) return false;
  return true;
}

function addToken(out, token) {
  const normalized = String(token || '').toLowerCase();
  if (normalized.length > 0 && normalized.length <= 80) out.push(normalized);
}

/** 兼顾代码标识符、路径、英文与中文单字/二字/三字词。 */
function tokenize(text) {
  const out = [];
  const source = String(text || '');
  const ascii = source.match(/[A-Za-z][A-Za-z0-9_$.:/#-]*|\d+/g) || [];
  for (const raw of ascii) {
    addToken(out, raw);
    for (const part of raw.split(/[^A-Za-z0-9]+/)) {
      if (!part) continue;
      addToken(out, part);
      const camel = part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/);
      if (camel.length > 1) for (const item of camel) addToken(out, item);
    }
  }
  const cjkRuns = source.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 12) addToken(out, run);
    for (let i = 0; i < run.length; i++) {
      addToken(out, run[i]);
      if (i + 1 < run.length) addToken(out, run.slice(i, i + 2));
      if (i + 2 < run.length) addToken(out, run.slice(i, i + 3));
    }
  }
  return out;
}

function informativeTerms(text) {
  const tokens = [...new Set(tokenize(text))];
  const filtered = tokens.filter((token) => {
    if (STOP_WORDS.has(token)) return false;
    if (/^[\u3400-\u9fff]$/.test(token)) return false;
    return token.length >= 2;
  });
  return filtered.length ? filtered : tokens;
}

function termFrequency(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function readUtf8(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return null;
    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) return null;
    return text;
  } catch {
    return null;
  }
}

function readDocument(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    return extractDocumentText(fs.readFileSync(file), file)?.text || null;
  } catch {
    return null;
  }
}

function splitIntoChunks(relative, text, chunkLines, overlap, minChars = 12) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  const boundaryScore = (at) => {
    const next = lines[at] || '';
    const previous = lines[at - 1] || '';
    if (/^\s*#{1,6}\s+/.test(next)) return 3;
    if (/^\s*(?:(?:export|default|async|public|private|protected|static)\s+)*(?:function|class|interface|type|enum|def)\s+[\w$]+/.test(next)) return 3;
    if (/^\s*(?:async\s+)?[\w$]+\s*\([^)]*\)\s*(?::[^{}]+)?\s*\{\s*$/.test(next) && !/^\s*(?:if|for|while|switch|catch)\b/.test(next)) return 2;
    if (!previous.trim() && next.trim()) return 1;
    return 0;
  };
  for (let start = 0; start < lines.length;) {
    const hardEnd = Math.min(lines.length, start + chunkLines);
    let end = hardEnd;
    if (hardEnd < lines.length) {
      const minEnd = Math.min(hardEnd, start + Math.max(overlap + 1, Math.ceil(chunkLines * 0.6)));
      let bestScore = 0;
      for (let at = minEnd; at <= hardEnd; at++) {
        const score = boundaryScore(at);
        if (score >= bestScore && score > 0) {
          bestScore = score;
          end = at;
        }
      }
    }
    const content = lines.slice(start, end).join('\n').trimEnd();
    if (content.trim().length >= minChars) {
      const tokens = tokenize(relative + '\n' + content);
      chunks.push({
        id: relative + ':' + (start + 1) + ':' + end,
        path: relative,
        kind: 'text',
        startLine: start + 1,
        endLine: end,
        content,
        lowerContent: content.toLowerCase(),
        pathTerms: new Set(tokenize(relative)),
        frequencies: termFrequency(tokens),
        length: Math.max(1, tokens.length),
      });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function splitStructuredChunks(relative, text, segments, chunkLines, overlap) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  const step = Math.max(1, chunkLines - overlap);
  for (const segment of segments) {
    for (let startLine = segment.startLine; startLine <= segment.endLine; startLine += step) {
      const endLine = Math.min(segment.endLine, startLine + chunkLines - 1);
      const content = lines.slice(startLine - 1, endLine).join('\n').trimEnd();
      if (content.trim().length >= 12) {
        const contexts = [];
        if (segment.parentContext && segment.parentContext.content &&
            segment.parentContext.endLine < startLine) contexts.push(segment.parentContext);
        if (startLine > segment.startLine && segment.symbol) {
          const signatureEnd = Math.min(segment.endLine, segment.startLine + 3);
          contexts.push({
            startLine: segment.startLine,
            endLine: signatureEnd,
            content: lines.slice(segment.startLine - 1, signatureEnd).join('\n').trimEnd(),
          });
        }
        const searchable = relative + '\n' + (segment.qualifiedSymbol || '') + '\n' +
          (segment.aliases || []).join(' ') + '\n' + content;
        const tokens = tokenize(searchable);
        chunks.push({
          id: relative + ':' + startLine + ':' + endLine,
          path: relative, startLine, endLine, content,
          lowerContent: content.toLowerCase(),
          pathTerms: new Set(tokenize(relative)),
          frequencies: termFrequency(tokens), length: Math.max(1, tokens.length),
          kind: segment.kind, symbol: segment.symbol || '',
          qualifiedSymbol: segment.qualifiedSymbol || '',
          aliases: segment.aliases || [],
          parentSymbol: segment.parentSymbol || '',
          contexts, calls: segment.calls || [], references: segment.references || [],
          exported: !!segment.exported,
        });
      }
      if (endLine >= segment.endLine) break;
    }
  }
  return chunks;
}

function clipSource(content, startLine, endLine, maxChars) {
  const source = String(content || '');
  if (source.length <= maxChars) return { excerpt: source, endLine };
  const visible = source.slice(0, Math.max(0, maxChars - 1));
  const visibleEndLine = Math.min(endLine,
    startLine + (visible.match(/\n/g) || []).length - (visible.endsWith('\n') ? 1 : 0));
  return { excerpt: visible + '…', endLine: Math.max(startLine, visibleEndLine) };
}

function walkProject(root, maxFiles) {
  const files = [];
  const stack = [root];
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name) || EXTRA_IGNORED_DIRS.has(entry.name)) continue;
        stack.push(absolute);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = fs.statSync(absolute);
        } catch {
          continue;
        }
        files.push({
          absolute,
          relative: path.relative(root, absolute).replace(/\\/g, '/'),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
    if (truncated) break;
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return { files, truncated };
}

function normalizeQueries(primary, alternatives, maxQueries) {
  const raw = [primary, ...(Array.isArray(alternatives) ? alternatives : [])];
  const queries = [];
  const seen = new Set();
  for (const item of raw) {
    const query = String(item || '').trim().slice(0, 600);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

function confidenceFor(results, queryRuns, minCoverage) {
  if (!results.length) {
    return { level: 'none', answerable: false, basis: 'none', evidenceVerified: false, topCoverage: 0, topVectorScore: 0, coveredQueries: 0, queryCount: queryRuns.length, reason: '没有匹配片段' };
  }
  const topCoverage = Math.max(...results.map((item) => item.coverage || 0));
  const topVectorScore = Math.max(...results.map((item) => item.vectorScore || 0));
  const coveredQueries = queryRuns.filter((run) => run.ranked.some((item) => item.coverage >= minCoverage)).length;
  const queryRatio = queryRuns.length ? coveredQueries / queryRuns.length : 0;
  const exact = results.some((item) => item.exactPhrase);
  let level = 'low';
  if ((topCoverage >= 0.68 || (exact && topCoverage >= 0.5)) && queryRatio >= 0.5) level = 'high';
  else if (topCoverage >= minCoverage && queryRatio >= 0.34) level = 'medium';
  const semanticCandidate = results.some((item) => item.vectorOnly && item.vectorScore >= SEMANTIC_CANDIDATE_MIN_SCORE);
  // 向量相似度只决定哪些片段值得深读，不能独立证明来源足以回答。
  // 不同模型的余弦分标度差异很大；固定阈值会把无答案问题误判为可回答。
  const basis = topCoverage >= minCoverage ? 'lexical' : semanticCandidate ? 'semantic_candidate' : 'weak_match';
  return {
    level,
    answerable: level !== 'low',
    basis,
    evidenceVerified: false,
    topCoverage: Number(topCoverage.toFixed(4)),
    topVectorScore: Number(topVectorScore.toFixed(4)),
    coveredQueries,
    queryCount: queryRuns.length,
    reason:
      level === 'high'
        ? '查询词覆盖充分，仍需核对来源是否支持结论'
        : level === 'medium'
          ? '存在匹配候选，关键结论需继续深读原文件'
          : semanticCandidate
            ? '仅有纯向量命中候选；相似度不能证明可回答，请深读原文件核实，必要时改写查询'
            : '查询词覆盖较弱，应改写查询或缩小范围后再检索',
  };
}

function graphIntent(query) {
  return /跨文件|调用|依赖|引用|关系|链路|流程|谁使用|谁调用|\b(call|caller|depend|reference|flow|architecture)\b/i.test(String(query || ''));
}

class LocalRagIndex {
  constructor(root, options) {
    this.root = path.resolve(root || '.');
    this.options = normalizeOptions(options);
    this.includePatterns = compilePatterns(this.options.include);
    this.excludePatterns = compilePatterns(this.options.exclude);
    this.fileCache = new Map();
    this.dirtyFiles = new Set();
    this.forceRefresh = false;
    this.chunks = [];
    this.graph = null;
    this.lastRefresh = null;
    this.embedder = null;
    this.vectorStore = null;
    this.vectorStoreFatal = null;
    this.vectorStoreChange = null;
    this.lastVectorError = null;
    this.pendingChange = { deleted: /** @type {any[]} */ ([]), upserted: /** @type {any[]} */ ([]) };
    this.chunkById = new Map();
    this.stats = { indexedFiles: 0, chunks: 0, skippedFiles: 0, changedFiles: 0, removedFiles: 0, invalidatedFiles: 0, truncated: false };
  }

  /** 进程内记忆化向量表（仅 memory 后端有内容；milvus 后端返回空表，供诊断/测试观察）。 */
  get chunkVectors() {
    /** @type {any} */
    const store = this.vectorStore;
    return store && store.kind === 'memory' ? store.vectors : new Map();
  }

  ensureEmbedder() {
    if (this.embedder) return this.embedder;
    const provider = (this.options.embedProvider || 'none').toLowerCase();
    if (provider === 'none') {
      this.embedder = null;
      return null;
    }
    this.embedder = createEmbedder(this.options);
    return this.embedder;
  }

  /** 惰性装配向量后端。embedProvider=none 或装配失败 → null（向量层整体退化，检索仍可走 BM25）。 */
  ensureVectorStore() {
    if (this.vectorStore || this.vectorStoreFatal) return this.vectorStore;
    if ((this.options.embedProvider || 'none').toLowerCase() === 'none') return null;
    try {
      this.vectorStore = createVectorStore({
        backend: this.options.vectorStore,
        root: this.root,
        dim: this.options.embedDim,
        provider: this.options.embedProvider,
        model: this.options.embedModel,
        base: this.options.embedBase,
        dimensions: this.options.embedDimensions,
        topK: this.options.embedTopK,
        address: this.options.milvusAddress,
        token: this.options.milvusToken,
        username: this.options.milvusUsername,
        password: this.options.milvusPassword,
        collection: this.options.milvusCollection,
        consistencyLevel: this.options.milvusConsistency,
        indexType: this.options.milvusIndexType,
        metricType: this.options.milvusMetricType,
        indexM: this.options.milvusIndexM,
        indexEfConstruction: this.options.milvusIndexEfConstruction,
        searchEf: this.options.milvusSearchEf,
        batchSize: this.options.milvusBatchSize,
        flushEveryBatches: this.options.milvusFlushEvery,
        client: this.options.vectorStoreClient || null,
      });
    } catch (error) {
      this.vectorStoreFatal = (error && error.message) || String(error);
      this.vectorStore = null;
    }
    return this.vectorStore;
  }

  /** 取/算单块向量（memory 后端记忆化；milvus 后端向量在服务端，返回 null）。 */
  async chunkVector(chunk) {
    const store = this.ensureVectorStore();
    if (!store) return null;
    return store.chunkVector(chunk, this.ensureEmbedder());
  }

  /** 把 refresh() 期间收集的文件增删落到向量后端（memory 后端无外部写入 → 空操作）。 */
  async syncVectorStore() {
    const store = this.ensureVectorStore();
    const change = this.pendingChange;
    this.pendingChange = { deleted: /** @type {any[]} */ ([]), upserted: /** @type {any[]} */ ([]) };
    if (!store || (!change.deleted.length && !change.upserted.length &&
      !(store.kind === 'sqlite' && !store.reconciled && !this.stats.truncated))) return null;
    // 失败后重试时，旧批次可能包含同一文件的过期块。始终以当前文件缓存构建最新版本。
    const affected = new Set([
      ...change.deleted.map((item) => item.relative),
      ...change.upserted.map((item) => item.path),
    ]);
    const deletedFiles = new Map(change.deleted.map((item) => [item.relative, item]));
    const current = {
      deleted: [...deletedFiles.values()],
      upserted: [...affected].flatMap((relative) =>
        (this.fileCache.get(relative)?.chunks || []).map((chunk) => ({
          id: chunk.id, path: chunk.path, text: chunk.path + '\n' + chunk.content,
        }))
      ),
      activeIds: this.stats.truncated ? null : [...this.chunkById.keys()],
    };
    try {
      const applied = await store.applyChanges(current, this.ensureEmbedder());
      this.vectorStoreChange = applied || this.vectorStoreChange;
      this.lastVectorError = null;
      return applied;
    } catch (error) {
      // 保留失败批次的文件名；下一轮从最新文件缓存重建块，避免丢更新或重放旧版本。
      this.pendingChange.deleted.unshift(...[...affected].map((relative) => ({ relative, chunkIds: [] })));
      this.lastVectorError = (error && error.message) || String(error);
      return null;
    }
  }

  /** 向量层诊断（含后端自身计数与降级原因），供 stats/工具输出使用。 */
  async vectorDiagnostics() {
    const store = this.vectorStore;
    if (this.vectorStoreFatal) {
      return { provider: this.options.embedProvider, backend: this.options.vectorStore, error: this.vectorStoreFatal };
    }
    if (!store) return null;
    /** @type {any} */
    let own = null;
    try {
      own = await store.stats();
    } catch (error) {
      own = { backend: store.kind, error: (error && error.message) || String(error) };
    }
    return { ...own, error: this.lastVectorError || (own && own.error) || undefined };
  }

  accepts(relative, size) {
    if (!shouldIndexFile(relative, size, this.options.maxFileBytes, this.options.maxDocumentBytes)) return false;
    if (this.includePatterns.length && !this.includePatterns.some((item) => item.regex.test(relative))) return false;
    if (this.excludePatterns.some((item) => item.regex.test(relative))) return false;
    return true;
  }

  invalidate(relative) {
    if (!relative) {
      this.forceRefresh = true;
      return;
    }
    const normalized = String(relative).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.split('/').includes('..')) return;
    this.dirtyFiles.add(normalized);
  }

  refresh(force) {
    const started = Date.now();
    const forceAll = force === true || this.forceRefresh;
    const invalidatedFiles = forceAll ? this.fileCache.size : this.dirtyFiles.size;
    const inventory = walkProject(this.root, this.options.maxFiles);
    const seen = new Set();
    let changedFiles = 0;
    let reusedFiles = 0;
    let skippedFiles = 0;

    for (const item of inventory.files) {
      seen.add(item.relative);
      if (!this.accepts(item.relative, item.size)) {
        skippedFiles++;
        this.dropFileVectors(item.relative);
        this.fileCache.delete(item.relative);
        this.dirtyFiles.delete(item.relative);
        continue;
      }
      const previous = this.fileCache.get(item.relative);
      const signature = item.size + ':' + item.mtimeMs;
      if (!forceAll && !this.dirtyFiles.has(item.relative) && previous && previous.signature === signature) {
        reusedFiles++;
        continue;
      }
      const document = isDocumentFile(item.relative);
      const text = document
        ? readDocument(item.absolute, this.options.maxDocumentBytes)
        : readUtf8(item.absolute, this.options.maxFileBytes);
      this.dropFileVectors(item.relative);
      if (text == null) {
        skippedFiles++;
        this.fileCache.delete(item.relative);
        this.dirtyFiles.delete(item.relative);
        continue;
      }
      // TypeScript 解析器体积较大，直到首次建立文件索引时才加载。
      const structure = CODE_FILE_RE.test(item.relative)
        ? require('./codeStructure.cjs').analyzeCode(item.relative, text) : null;
      const chunks = structure
        ? splitStructuredChunks(item.relative, text, structure.segments, this.options.chunkLines, this.options.chunkOverlap)
        : splitIntoChunks(item.relative, text, this.options.chunkLines, this.options.chunkOverlap, document ? 1 : 12);
      if (document) for (const chunk of chunks) chunk.kind = 'document';
      this.fileCache.set(item.relative, {
        signature,
        chunks,
        imports: structure ? structure.imports : [],
      });
      // 只有「本次重新分块」的文件才需要写入外部向量后端（未变文件复用已有向量）
      const freshChunks = this.fileCache.get(item.relative).chunks;
      for (const chunk of freshChunks) {
        this.pendingChange.upserted.push({ id: chunk.id, path: chunk.path, text: chunk.path + '\n' + chunk.content });
      }
      this.dirtyFiles.delete(item.relative);
      changedFiles++;
    }

    let removedFiles = 0;
    for (const relative of [...this.fileCache.keys()]) {
      if (!seen.has(relative)) {
        this.dropFileVectors(relative);
        this.fileCache.delete(relative);
        this.dirtyFiles.delete(relative);
        removedFiles++;
      }
    }

    this.forceRefresh = false;
    this.chunks = [...this.fileCache.values()].flatMap((entry) => entry.chunks);
    this.chunkById = new Map(this.chunks.map((chunk) => [chunk.id, chunk]));
    if (!this.graph || changedFiles || removedFiles || forceAll) {
      this.graph = buildCodeGraph(this.fileCache, this.chunks);
    }
    this.lastRefresh = new Date().toISOString();
    this.stats = {
      indexedFiles: this.fileCache.size,
      indexedAt: this.lastRefresh,
      chunks: this.chunks.length,
      graph: this.graph.stats,
      skippedFiles,
      changedFiles,
      reusedFiles,
      removedFiles,
      invalidatedFiles,
      truncated: inventory.truncated,
      durationMs: Date.now() - started,
    };
    return this.stats;
  }

  dropFileVectors(relative) {
    const previous = this.fileCache.get(relative);
    if (!previous) return;
    const chunkIds = previous.chunks.map((chunk) => chunk.id);
    // 同步清理进程内记忆化（refresh() 保持同步语义；memory 后端有实际作用，milvus 为 no-op）
    if (this.vectorStore) {
      try {
        this.vectorStore.dropLocal(relative, chunkIds);
      } catch (error) {
        this.lastVectorError = (error && error.message) || String(error);
      }
    }
    // 外部后端（milvus）的删除由 syncVectorStore() 异步执行
    this.pendingChange.deleted.push({ relative, chunkIds });
  }

  scopedCandidates(options) {
    const opts = options || {};
    const scope = String(opts.path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (path.isAbsolute(scope) || /^[A-Za-z]:/.test(scope) || scope.split('/').includes('..')) {
      throw new Error('检索路径不能越过项目边界');
    }
    let fileRegex = null;
    if (opts.filePattern) {
      const pattern = String(opts.filePattern).trim().replace(/\\/g, '/');
      if (pattern.length > 300) throw new Error('filePattern 过长');
      fileRegex = globToRegExp(pattern);
    }
    return this.chunks.filter((chunk) => {
      if (scope && chunk.path !== scope && !chunk.path.startsWith(scope + '/')) return false;
      return !fileRegex || fileRegex.test(chunk.path);
    });
  }

  scoreQuery(query, candidates) {
    const terms = informativeTerms(query);
    const documentFrequency = new Map();
    for (const term of terms) {
      let count = 0;
      for (const chunk of candidates) if (chunk.frequencies.has(term)) count++;
      documentFrequency.set(term, count);
    }
    const averageLength = candidates.reduce((sum, chunk) => sum + chunk.length, 0) / Math.max(1, candidates.length);
    const queryLower = query.toLowerCase();
    const maxIdf = Math.log(1 + (candidates.length + 0.5) / 0.5);
    const totalWeight = terms.reduce((sum, term) => {
      const df = documentFrequency.get(term) || 0;
      return sum + (df ? Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5)) : maxIdf);
    }, 0) || 1;
    const ranked = [];
    const k1 = this.options.bm25K1;
    const b = this.options.bm25B;

    for (const chunk of candidates) {
      let score = 0;
      let matchedWeight = 0;
      const matchedTerms = [];
      for (const term of terms) {
        const df = documentFrequency.get(term) || 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
        const tf = chunk.frequencies.get(term) || 0;
        const pathMatch = chunk.pathTerms.has(term);
        if (tf > 0) {
          const normalized = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (chunk.length / averageLength)));
          score += idf * normalized;
          matchedWeight += idf;
          matchedTerms.push(term);
        }
        if (pathMatch) score += idf * 0.9;
      }
      const exactPhrase = queryLower.length >= 3 && chunk.lowerContent.includes(queryLower);
      if (exactPhrase) score += 5;
      if (queryLower.length >= 2 && chunk.path.toLowerCase().includes(queryLower)) score += 3;
      const coverage = Math.min(1, matchedWeight / totalWeight);
      if (matchedTerms.length >= 2) score += coverage * 2;
      if (score > 0) ranked.push({ chunk, score, coverage, exactPhrase, matchedTerms });
    }
    ranked.sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.startLine - b.chunk.startLine);
    return { query, terms, ranked };
  }

  async retrieve(query, options) {
    const opts = options || {};
    const started = Date.now();
    const stats = this.refresh(opts.refresh === true);
    // 外部向量后端（milvus）在 refresh 期间只收集增删，这里落库后再检索
    const hadVectorChanges = this.pendingChange.deleted.length > 0 || this.pendingChange.upserted.length > 0;
    const vectorChange = await this.syncVectorStore();
    const vectorSyncError = hadVectorChanges ? this.lastVectorError : null;
    const mode = String(opts.mode || 'auto').toLowerCase();
    const queries = normalizeQueries(query, opts.queries, this.options.maxQueries);
    if (!queries.length || this.chunks.length === 0) {
      return { query: String(query || '').trim(), queries, results: [], quality: confidenceFor([], queries.map((item) => ({ query: item, ranked: [] })), this.options.minCoverage), stats };
    }
    const candidates = this.scopedCandidates(opts);
    if (!candidates.length) {
      return { query: queries[0], queries, results: [], quality: confidenceFor([], queries.map((item) => ({ query: item, ranked: [] })), this.options.minCoverage), stats: { ...stats, candidateChunks: 0 } };
    }

    const queryRuns = queries.map((item) => this.scoreQuery(item, candidates));
    const allowedChunkIds = new Set(candidates.map((item) => item.id));
    const topK = clampInteger(opts.topK, this.options.topK, 1, 20);
    const fusionDepth = Math.max(30, topK * 6);
    const fused = new Map();
    queryRuns.forEach((run, queryIndex) => {
      const queryWeight = queryIndex === 0 ? 1 : 0.9;
      run.ranked.slice(0, fusionDepth).forEach((item, rank) => {
        let entry = fused.get(item.chunk.id);
        if (!entry) {
          entry = {
            chunk: item.chunk,
            fusion: 0,
            score: 0,
            coverage: 0,
            exactPhrase: false,
            matchedQueries: [],
            matchedTerms: new Set(),
          };
          fused.set(item.chunk.id, entry);
        }
        entry.fusion += queryWeight / (60 + rank + 1);
        entry.score = Math.max(entry.score, item.score);
        entry.coverage = Math.max(entry.coverage, item.coverage);
        entry.exactPhrase = entry.exactPhrase || item.exactPhrase;
        entry.matchedQueries.push(run.query);
        for (const term of item.matchedTerms) entry.matchedTerms.add(term);
      });
    });

    const ranked = [...fused.values()].sort((a, b) => b.fusion - a.fusion || b.score - a.score);
    const provider = (this.options.embedProvider || 'none').toLowerCase();
    const vectorWeight = mode === 'vector' ? 1 : mode === 'file' ? 0 : this.options.vectorWeight;
    const vectorEnabled = provider !== 'none' && vectorWeight > 0 && (mode === 'auto' || mode === 'hybrid' || mode === 'vector');
    // 学习式嵌入的小型 memory 索引独立召回；显式启用的哈希向量只重排 BM25 候选。
    let vectorScoresMap = new Map();
    let vectorOnly = 0;
    let vectorError = vectorSyncError;
    // 写入/删除失败时服务端可能仍有旧块，本轮不要继续使用可能过期的 ANN 结果。
    const vectorStore = vectorEnabled && !vectorSyncError ? this.ensureVectorStore() : null;
    const memorySemanticFullScan = !!vectorStore && vectorStore.kind === 'memory' &&
      provider !== 'local' && candidates.length <= this.options.memorySemanticMaxChunks &&
      this.options.memorySemanticMaxChunks > 0;
    const memorySemanticSkipped = !!vectorStore && vectorStore.kind === 'memory' && provider !== 'local' &&
      !memorySemanticFullScan;
    if (vectorEnabled && vectorStore) {
      try {
        if (vectorStore.prefiltered && !memorySemanticFullScan) {
          const topCandidates = ranked.slice(0, this.options.embedTopK).map((item) => item.chunk);
          vectorScoresMap = await vectorStore.scoreCandidates(queries[0], topCandidates, this.ensureEmbedder());
        } else {
          const scopedFiles = opts.path || opts.filePattern
            ? [...new Set(candidates.map((chunk) => chunk.path))]
            : null;
          vectorScoresMap = await vectorStore.scoreCandidates(queries[0], memorySemanticFullScan ? candidates : null,
            this.ensureEmbedder(), { files: scopedFiles });
          // Milvus 在服务端预过滤，本地再次校验；memory 全量扫描也只接收本次范围内的块。
          vectorScoresMap = new Map([...vectorScoresMap].filter(([id]) => allowedChunkIds.has(id)));
          const known = new Set(ranked.map((item) => item.chunk.id));
          for (const [id, score] of vectorScoresMap) {
            if (known.has(id)) continue;
            const chunk = this.chunkById.get(id);
            // 纯向量命中必须过最低相似度/贡献门槛，避免低分块涌入上下文。
            if (!chunk || (memorySemanticFullScan || vectorStore.kind === 'sqlite'
              ? score < SEMANTIC_CANDIDATE_MIN_SCORE
              : score * 100 * vectorWeight < VECTOR_ONLY_MIN_CONTRIBUTION)) continue;
            known.add(id);
            ranked.push({
              chunk,
              fusion: 0,
              score: 0,
              coverage: 0,
              exactPhrase: false,
              matchedQueries: [],
              matchedTerms: new Set(),
              vectorOnly: true,
            });
            vectorOnly += 1;
          }
        }
        if (!vectorSyncError) this.lastVectorError = null;
      } catch (error) {
        vectorScoresMap = new Map();
        vectorError = (error && error.message) || String(error);
        this.lastVectorError = vectorError;
      }
    }
    const vectorOrder = [...vectorScoresMap].filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const vectorRank = new Map(vectorOrder.map(([id], rank) => [id, 1 / (60 + rank + 1)]));
    const lexicalNormalizer = 1 + Math.max(0, queries.length - 1) * 0.9;
    const lexicalWeight = vectorOrder.length === 0 ? 1 : mode === 'vector' ? 0.15 : 1 - vectorWeight;
    const semanticWeight = vectorOrder.length === 0 ? 0 : mode === 'vector' ? 0.85 : vectorWeight;
    for (const item of ranked) {
      item.vectorScore = vectorScoresMap.get(item.chunk.id) || 0;
      item.rankScore =
        (item.fusion / lexicalNormalizer * lexicalWeight +
          (vectorRank.get(item.chunk.id) || 0) * semanticWeight) * 1000 +
        Math.min(item.score, 100) * 0.001 +
        item.coverage * 0.1 +
        (item.exactPhrase ? 0.05 : 0);
    }
    ranked.sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));

    const requestedHops = clampInteger(opts.hops, this.options.graphHops, 0, 2);
    const initialCoverage = ranked.length ? Math.max(...ranked.slice(0, 3).map((item) => item.coverage || 0)) : 0;
    const graph = this.graph;
    const expandGraph = requestedHops > 0 && graph &&
      (opts.hops != null || graphIntent(queries[0]) || ranked.length < Math.min(3, topK) || initialCoverage < this.options.minCoverage);
    let graphExpanded = 0;
    if (expandGraph && graph) {
      const known = new Set(ranked.map((item) => item.chunk.id));
      if (ranked.length < 3) {
        for (const chunk of graph.symbolMatches(queries.join(' '), 3)) {
          if (!allowedChunkIds.has(chunk.id) || known.has(chunk.id)) continue;
          const item = { chunk, score: 0, fusion: 0, coverage: 0, exactPhrase: false,
            matchedQueries: [], matchedTerms: new Set(), vectorScore: 0, rankScore: 8,
            graphOnly: true, graphRelation: 'defines' };
          ranked.push(item);
          known.add(chunk.id);
          graphExpanded++;
        }
      }
      let frontier = ranked.slice(0, 3).map((item) => ({ id: item.chunk.id, rankScore: item.rankScore }));
      for (let depth = 1; depth <= requestedHops && frontier.length && graphExpanded < 12; depth++) {
        const next = [];
        for (const seed of frontier.slice(0, 5)) {
          for (const edge of graph.neighbors(seed.id, 8)) {
            if (known.has(edge.id) || !allowedChunkIds.has(edge.id)) continue;
            const chunk = this.chunkById.get(edge.id);
            if (!chunk) continue;
            const rankScore = Math.min(8, seed.rankScore * 0.55) / depth;
            ranked.push({ chunk, score: 0, fusion: 0, coverage: 0, exactPhrase: false,
              matchedQueries: [], matchedTerms: new Set(), vectorScore: 0, rankScore,
              graphOnly: true, graphRelation: edge.relation });
            known.add(edge.id);
            next.push({ id: edge.id, rankScore });
            graphExpanded++;
            if (graphExpanded >= 12) break;
          }
          if (graphExpanded >= 12) break;
        }
        frontier = next;
      }
      ranked.sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));
    }

    let rerankApplied = false;
    let rerankError = null;
    let rerankCount = 0;
    if (this.options.rerankUrl || this.options.rerankClient) {
      const shortlist = ranked.slice(0, this.options.rerankTopK);
      for (const item of ranked) {
        if ((item.vectorOnly || item.graphOnly) && !shortlist.includes(item) && shortlist.length < 40) shortlist.push(item);
      }
      try {
        const scores = await rerankCandidates(queries[0], shortlist, {
          url: this.options.rerankUrl, model: this.options.rerankModel,
          key: this.options.rerankKey, timeoutMs: this.options.rerankTimeoutMs,
          client: this.options.rerankClient,
        });
        if (scores) {
          const ordered = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
          for (let rank = 0; rank < ordered.length; rank++) {
            const item = ranked.find((candidate) => candidate.chunk.id === ordered[rank][0]);
            if (!item) continue;
            item.rrfScore = item.rankScore;
            item.rerankScore = ordered[rank][1];
            item.rankScore = 100 + ordered.length - rank;
          }
          ranked.sort((a, b) => b.rankScore - a.rankScore || a.chunk.path.localeCompare(b.chunk.path));
          rerankApplied = true;
          rerankCount = ordered.length;
        }
      } catch (error) {
        rerankError = (error && error.message) || String(error);
      }
    }

    const maxChars = clampInteger(opts.maxChars, this.options.maxContextChars, 1000, 50000);
    const chosen = [];
    const chosenIds = new Set();
    const parentContextSeen = new Set();
    const perFile = new Map();
    let usedChars = 0;
    const addResult = (item) => {
      if (chosen.length >= topK || chosenIds.has(item.chunk.id)) return false;
      const redundant = chosen.some((prior) => {
        if (prior.path !== item.chunk.path) return false;
        const overlap = Math.max(0, Math.min(prior.endLine, item.chunk.endLine) - Math.max(prior.startLine, item.chunk.startLine) + 1);
        const shorter = Math.min(prior.endLine - prior.startLine + 1, item.chunk.endLine - item.chunk.startLine + 1);
        return overlap / Math.max(1, shorter) >= 0.6;
      });
      if (redundant) return false;
      const remaining = maxChars - usedChars;
      if (remaining < 120) return false;
      const contexts = [];
      let contextChars = 0;
      for (const context of item.chunk.contexts || []) {
        if (!context.content || context.endLine >= item.chunk.startLine) continue;
        const key = item.chunk.path + ':' + context.startLine + ':' + context.endLine;
        if (parentContextSeen.has(key) || contexts.some((part) => part.key === key)) continue;
        const budget = Math.min(PARENT_CONTEXT_CHARS - contextChars, remaining - contextChars - 120);
        if (budget < 24) break;
        const clipped = clipSource(context.content, context.startLine, context.endLine, budget);
        contexts.push({ key, citation: item.chunk.path + '#L' + context.startLine + '-L' + clipped.endLine,
          path: item.chunk.path, startLine: context.startLine, endLine: clipped.endLine, excerpt: clipped.excerpt });
        contextChars += clipped.excerpt.length;
      }
      const clipped = clipSource(item.chunk.content, item.chunk.startLine, item.chunk.endLine, remaining - contextChars);
      chosen.push({
        citation: item.chunk.path + '#L' + item.chunk.startLine + '-L' + clipped.endLine,
        path: item.chunk.path,
        kind: item.chunk.kind || 'text',
        symbol: item.chunk.qualifiedSymbol || undefined,
        startLine: item.chunk.startLine,
        endLine: clipped.endLine,
        score: Number(item.score.toFixed(4)),
        fusionScore: Number((item.rrfScore == null ? item.rankScore : item.rrfScore).toFixed(4)),
        rerankScore: item.rerankScore == null ? undefined : Number(item.rerankScore.toFixed(4)),
        selectionScore: Number(item.rankScore.toFixed(4)),
        coverage: Number(item.coverage.toFixed(4)),
        exactPhrase: item.exactPhrase,
        vectorOnly: item.vectorOnly === true,
        vectorScore: Number(item.vectorScore.toFixed(4)),
        graphOnly: item.graphOnly === true,
        graphRelation: item.graphRelation || undefined,
        matchedQueries: [...new Set(item.matchedQueries)],
        matchedTerms: [...item.matchedTerms].slice(0, 16),
        excerpt: clipped.excerpt,
        contexts: contexts.map(({ key, ...context }) => context),
      });
      chosenIds.add(item.chunk.id);
      for (const context of contexts) parentContextSeen.add(context.key);
      perFile.set(item.chunk.path, (perFile.get(item.chunk.path) || 0) + 1);
      usedChars += clipped.excerpt.length + contextChars;
      return true;
    };
    // 至多预留三分之一席位给高分纯向量命中，避免词法 Top-K 占满上下文。
    const semanticReserve = rerankApplied ? 0 : Math.min(2, Math.floor(topK / 3));
    for (const item of ranked.filter((entry) => entry.vectorOnly && entry.vectorScore >= SEMANTIC_CANDIDATE_MIN_SCORE).slice(0, semanticReserve)) {
      addResult(item);
    }
    if (!rerankApplied && topK >= 4) {
      const graphCandidate = ranked.find((entry) => entry.graphOnly);
      if (graphCandidate) addResult(graphCandidate);
    }
    for (const item of ranked) {
      if ((perFile.get(item.chunk.path) || 0) >= 2) continue;
      addResult(item);
      if (chosen.length >= topK || maxChars - usedChars < 120) break;
    }
    if (chosen.length < topK && maxChars - usedChars >= 120) {
      for (const item of ranked) {
        addResult(item);
        if (chosen.length >= topK || maxChars - usedChars < 120) break;
      }
    }
    chosen.sort((a, b) => b.selectionScore - a.selectionScore || a.path.localeCompare(b.path));

    const quality = confidenceFor(chosen, queryRuns, this.options.minCoverage);
    const vectorStats = await this.vectorDiagnostics();
    return {
      query: queries[0],
      queries,
      results: chosen,
      quality,
      stats: {
        ...stats,
        candidateChunks: candidates.length,
        fusedCandidates: ranked.length,
        graph: { ...(graph ? graph.stats : {}), expanded: graphExpanded, hops: expandGraph ? requestedHops : 0 },
        rerank: { enabled: !!(this.options.rerankUrl || this.options.rerankClient), applied: rerankApplied,
          candidates: rerankCount, error: rerankError || undefined },
        vector: {
          provider: vectorEnabled ? this.options.embedProvider : 'none',
          backend: vectorEnabled && this.vectorStore ? this.vectorStore.kind : 'none',
          prefiltered: vectorEnabled && this.vectorStore ? this.vectorStore.prefiltered && !memorySemanticFullScan : null,
          memorySemanticFullScan,
          memorySemanticSkipped,
          memorySemanticMaxChunks: this.options.memorySemanticMaxChunks,
          weight: vectorWeight,
          rankedWithVector: vectorScoresMap.size,
          vectorOnly,
          applied: vectorChange || undefined,
          store: vectorStats || undefined,
          error: vectorError || (vectorStats && vectorStats.error) || undefined,
        },
        retrievalDurationMs: Date.now() - started,
      },
    };
  }
}

const INDEX_CACHE = new Map();

function cacheKey(root, options) {
  const normalized = normalizeOptions(options);
  // 注入的测试客户端不参与缓存键（同一工程 + 同一配置应复用同一索引）
  delete normalized.vectorStoreClient;
  delete normalized.rerankClient;
  return path.resolve(root || '.') + '\n' + JSON.stringify(normalized);
}

function getProjectIndex(root, options) {
  const key = cacheKey(root, options);
  let index = INDEX_CACHE.get(key);
  if (!index) {
    index = new LocalRagIndex(root, options);
    INDEX_CACHE.set(key, index);
  }
  return index;
}

function invalidateProjectIndex(root, relative) {
  const resolvedRoot = path.resolve(root || '.');
  let count = 0;
  for (const index of INDEX_CACHE.values()) {
    if (index.root !== resolvedRoot) continue;
    index.invalidate(relative);
    count++;
  }
  return count;
}

function clearIndexCache() {
  // 顺带关闭外部向量后端连接（memory 后端为 no-op；注入的测试客户端不关闭）
  for (const index of INDEX_CACHE.values()) {
    const store = index.vectorStore;
    if (!store || typeof store.close !== 'function') continue;
    try {
      const pending = store.close();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* 关闭失败不影响缓存清理 */
    }
  }
  INDEX_CACHE.clear();
}

module.exports = {
  DEFAULTS,
  LocalRagIndex,
  clearIndexCache,
  getProjectIndex,
  informativeTerms,
  invalidateProjectIndex,
  isSensitiveFile,
  normalizeOptions,
  normalizeQueries,
  tokenize,
};
