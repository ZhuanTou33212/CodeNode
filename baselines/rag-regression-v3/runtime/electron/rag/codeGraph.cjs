/** 项目内 TS/JS 的轻量定义、引用、调用与导入关系索引。静态近似，不代替类型检查或 LSP。 */
'use strict';

const path = require('path');

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

function resolveImport(from, specifier, files) {
  if (!specifier || !specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) return null;
  const attempts = [base];
  for (const ext of EXTENSIONS) attempts.push(base + ext, base + '/index' + ext);
  if (/\.jsx?$/.test(base)) {
    const stem = base.replace(/\.jsx?$/, '');
    attempts.push(stem + '.ts', stem + '.tsx');
  }
  return attempts.find((candidate) => files.has(candidate)) || null;
}

function buildCodeGraph(fileCache, chunks) {
  const files = new Set(fileCache.keys());
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const byFile = new Map();
  const definitions = new Map();
  for (const chunk of chunks) {
    const list = byFile.get(chunk.path) || [];
    list.push(chunk);
    byFile.set(chunk.path, list);
    for (const name of [chunk.symbol, ...(chunk.aliases || [])].filter(Boolean)) {
      const key = name.toLowerCase();
      const defs = definitions.get(key) || [];
      if (!defs.some((item) => item.path === chunk.path && item.qualifiedSymbol === chunk.qualifiedSymbol)) defs.push(chunk);
      definitions.set(key, defs);
    }
  }
  const imports = new Map();
  const importedBy = new Map();
  for (const [file, entry] of fileCache) {
    const targets = new Set();
    for (const specifier of entry.imports || []) {
      const resolved = resolveImport(file, specifier, files);
      if (!resolved) continue;
      targets.add(resolved);
      const incoming = importedBy.get(resolved) || new Set();
      incoming.add(file);
      importedBy.set(resolved, incoming);
    }
    imports.set(file, targets);
  }

  const links = new Map();
  const addLink = (from, to, relation) => {
    if (!from || !to || from === to) return;
    const neighbors = links.get(from) || new Map();
    if (!neighbors.has(to)) neighbors.set(to, relation);
    links.set(from, neighbors);
  };
  const candidatesFor = (caller, name) => {
    const defs = definitions.get(String(name).toLowerCase()) || [];
    const sameFile = defs.filter((item) => item.path === caller.path);
    if (sameFile.length) return sameFile.slice(0, 3);
    const imported = imports.get(caller.path) || new Set();
    const inImports = defs.filter((item) => imported.has(item.path));
    return inImports.slice(0, 3);
  };
  for (const caller of chunks) {
    if (!caller.symbol) continue;
    const called = new Set(caller.calls || []);
    for (const name of called) {
      for (const definition of candidatesFor(caller, name)) {
        addLink(caller.id, definition.id, 'calls');
        addLink(definition.id, caller.id, 'called_by');
      }
    }
    for (const name of caller.references || []) {
      if (called.has(name) || name === caller.symbol) continue;
      for (const definition of candidatesFor(caller, name)) {
        addLink(caller.id, definition.id, 'references');
        addLink(definition.id, caller.id, 'referenced_by');
      }
    }
  }
  const representatives = (file) => {
    const list = (byFile.get(file) || []).filter((chunk) => chunk.symbol && chunk.kind !== 'class');
    return (list.filter((chunk) => chunk.exported).length ? list.filter((chunk) => chunk.exported) : list).slice(0, 2);
  };
  const neighbors = (id, max = 16) => {
    const chunk = byId.get(id);
    if (!chunk) return [];
    const result = new Map(links.get(id) || []);
    for (const file of imports.get(chunk.path) || []) {
      for (const target of representatives(file)) if (target.id !== id && !result.has(target.id)) result.set(target.id, 'imports');
    }
    for (const file of importedBy.get(chunk.path) || []) {
      for (const source of representatives(file)) if (source.id !== id && !result.has(source.id)) result.set(source.id, 'imported_by');
    }
    return [...result].slice(0, max).map(([targetId, relation]) => ({ id: targetId, relation }));
  };
  const symbolMatches = (query, max = 12) => {
    const found = new Map();
    const names = String(query || '').match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [];
    for (const name of names) {
      for (const chunk of definitions.get(name.toLowerCase()) || []) {
        if (!found.has(chunk.id)) found.set(chunk.id, chunk);
        if (found.size >= max) return [...found.values()];
      }
    }
    return [...found.values()];
  };
  return {
    neighbors,
    symbolMatches,
    toSnapshot: () => ({
      neighbors: new Map([...byId.keys()].map((id) => [id, neighbors(id, 16)])),
      definitions: new Map([...definitions].map(([name, items]) => [name, items.map((item) => item.id)])),
    }),
    stats: {
      files: files.size,
      symbols: [...definitions.values()].reduce((sum, items) => sum + items.length, 0),
      links: [...links.values()].reduce((sum, items) => sum + items.size, 0),
    },
  };
}

function fromSnapshot(snapshot, chunks, stats) {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return {
    stats,
    neighbors: (id, max = 16) => (snapshot.neighbors.get(id) || []).slice(0, max),
    symbolMatches: (query, max = 12) => {
      const found = new Map();
      for (const name of String(query || '').match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || []) {
        for (const id of snapshot.definitions.get(name.toLowerCase()) || []) {
          if (byId.has(id) && !found.has(id)) found.set(id, byId.get(id));
          if (found.size >= max) return [...found.values()];
        }
      }
      return [...found.values()];
    },
  };
}
module.exports = { buildCodeGraph, fromSnapshot, resolveImport };
