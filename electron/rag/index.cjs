/**
 * CodeNode 本地 Agentic RAG 索引。
 *
 * - 零网络、零外部服务；
 * - 文件级增量缓存与显式失效；
 * - BM25 + 路径/短语/覆盖率加权；
 * - 多查询 Reciprocal Rank Fusion；
 * - 行号来源、相关性诊断与敏感文件硬排除。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { shouldSkipDir, isBinaryFileName } = require('../tools/toolFiles.cjs');
const { globToRegExp } = require('../tools/impl/shared.cjs');

const DEFAULTS = Object.freeze({
  enabled: true,
  maxFiles: 5000,
  maxFileBytes: 512 * 1024,
  chunkLines: 72,
  chunkOverlap: 12,
  topK: 6,
  maxContextChars: 12000,
  maxQueries: 5,
  minCoverage: 0.2,
  include: [],
  exclude: [],
});

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
    chunkLines,
    chunkOverlap: clampInteger(o.chunkOverlap, DEFAULTS.chunkOverlap, 0, Math.max(0, chunkLines - 1)),
    topK: clampInteger(o.topK, DEFAULTS.topK, 1, 20),
    maxContextChars: clampInteger(o.maxContextChars, DEFAULTS.maxContextChars, 1000, 50000),
    maxQueries: clampInteger(o.maxQueries, DEFAULTS.maxQueries, 1, 8),
    minCoverage: clampNumber(o.minCoverage, DEFAULTS.minCoverage, 0.05, 1),
    include: normalizePatterns(o.include),
    exclude: normalizePatterns(o.exclude),
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

function shouldIndexFile(relative, size, maxFileBytes) {
  const normalized = relative.replace(/\\/g, '/');
  const name = path.posix.basename(normalized).toLowerCase();
  if (!size || size > maxFileBytes) return false;
  if (isBinaryFileName(name) || isSensitiveFile(normalized) || NOISY_FILES.has(name)) return false;
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

function splitIntoChunks(relative, text, chunkLines, overlap) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  const step = Math.max(1, chunkLines - overlap);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + chunkLines);
    const content = lines.slice(start, end).join('\n').trimEnd();
    if (content.trim().length >= 12) {
      const tokens = tokenize(relative + '\n' + content);
      chunks.push({
        id: relative + ':' + (start + 1) + ':' + end,
        path: relative,
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
  }
  return chunks;
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
    return { level: 'none', answerable: false, topCoverage: 0, coveredQueries: 0, queryCount: queryRuns.length, reason: '没有匹配片段' };
  }
  const topCoverage = Math.max(...results.map((item) => item.coverage || 0));
  const coveredQueries = queryRuns.filter((run) => run.ranked.some((item) => item.coverage >= minCoverage)).length;
  const queryRatio = queryRuns.length ? coveredQueries / queryRuns.length : 0;
  const exact = results.some((item) => item.exactPhrase);
  let level = 'low';
  if ((topCoverage >= 0.68 || (exact && topCoverage >= 0.5)) && queryRatio >= 0.5) level = 'high';
  else if (topCoverage >= minCoverage && queryRatio >= 0.34) level = 'medium';
  return {
    level,
    answerable: level !== 'low',
    topCoverage: Number(topCoverage.toFixed(4)),
    coveredQueries,
    queryCount: queryRuns.length,
    reason:
      level === 'high'
        ? '查询词覆盖充分，可基于来源回答'
        : level === 'medium'
          ? '存在可用来源，关键结论建议继续深读原文件'
          : '查询词覆盖较弱，应改写查询或缩小范围后再检索',
  };
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
    this.lastRefresh = null;
    this.stats = { indexedFiles: 0, chunks: 0, skippedFiles: 0, changedFiles: 0, removedFiles: 0, invalidatedFiles: 0, truncated: false };
  }

  accepts(relative, size) {
    if (!shouldIndexFile(relative, size, this.options.maxFileBytes)) return false;
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
      const text = readUtf8(item.absolute, this.options.maxFileBytes);
      if (text == null) {
        skippedFiles++;
        this.fileCache.delete(item.relative);
        this.dirtyFiles.delete(item.relative);
        continue;
      }
      this.fileCache.set(item.relative, {
        signature,
        chunks: splitIntoChunks(item.relative, text, this.options.chunkLines, this.options.chunkOverlap),
      });
      this.dirtyFiles.delete(item.relative);
      changedFiles++;
    }

    let removedFiles = 0;
    for (const relative of [...this.fileCache.keys()]) {
      if (!seen.has(relative)) {
        this.fileCache.delete(relative);
        this.dirtyFiles.delete(relative);
        removedFiles++;
      }
    }

    this.forceRefresh = false;
    this.chunks = [...this.fileCache.values()].flatMap((entry) => entry.chunks);
    this.lastRefresh = new Date().toISOString();
    this.stats = {
      indexedFiles: this.fileCache.size,
      chunks: this.chunks.length,
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
    const k1 = 1.35;
    const b = 0.72;

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

  retrieve(query, options) {
    const opts = options || {};
    const started = Date.now();
    const stats = this.refresh(opts.refresh === true);
    const queries = normalizeQueries(query, opts.queries, this.options.maxQueries);
    if (!queries.length || this.chunks.length === 0) {
      return { query: String(query || '').trim(), queries, results: [], quality: confidenceFor([], queries.map((item) => ({ query: item, ranked: [] })), this.options.minCoverage), stats };
    }
    const candidates = this.scopedCandidates(opts);
    if (!candidates.length) {
      return { query: queries[0], queries, results: [], quality: confidenceFor([], queries.map((item) => ({ query: item, ranked: [] })), this.options.minCoverage), stats: { ...stats, candidateChunks: 0 } };
    }

    const queryRuns = queries.map((item) => this.scoreQuery(item, candidates));
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

    const ranked = [...fused.values()];
    for (const item of ranked) {
      item.rankScore = item.fusion * 1000 + Math.min(item.score, 100) * 0.02 + item.coverage * 2 + (item.exactPhrase ? 1 : 0);
    }
    ranked.sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));

    const maxChars = clampInteger(opts.maxChars, this.options.maxContextChars, 1000, 50000);
    const chosen = [];
    const chosenIds = new Set();
    const perFile = new Map();
    let usedChars = 0;
    const addResult = (item) => {
      if (chosen.length >= topK || chosenIds.has(item.chunk.id)) return false;
      const remaining = maxChars - usedChars;
      if (remaining < 120) return false;
      let excerpt = item.chunk.content;
      if (excerpt.length > remaining) excerpt = excerpt.slice(0, Math.max(0, remaining - 1)) + '…';
      chosen.push({
        citation: item.chunk.path + '#L' + item.chunk.startLine + '-L' + item.chunk.endLine,
        path: item.chunk.path,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
        score: Number(item.score.toFixed(4)),
        fusionScore: Number(item.rankScore.toFixed(4)),
        coverage: Number(item.coverage.toFixed(4)),
        exactPhrase: item.exactPhrase,
        matchedQueries: [...new Set(item.matchedQueries)],
        matchedTerms: [...item.matchedTerms].slice(0, 16),
        excerpt,
      });
      chosenIds.add(item.chunk.id);
      perFile.set(item.chunk.path, (perFile.get(item.chunk.path) || 0) + 1);
      usedChars += excerpt.length;
      return true;
    };
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

    const quality = confidenceFor(chosen, queryRuns, this.options.minCoverage);
    return {
      query: queries[0],
      queries,
      results: chosen,
      quality,
      stats: {
        ...stats,
        candidateChunks: candidates.length,
        fusedCandidates: ranked.length,
        retrievalDurationMs: Date.now() - started,
      },
    };
  }
}

const INDEX_CACHE = new Map();

function cacheKey(root, options) {
  return path.resolve(root || '.') + '\n' + JSON.stringify(normalizeOptions(options));
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
