'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFile } = require('./atomicFile.cjs');

const MAX = 12;
const MAX_BYTES = 256 * 1024;
const fileOf = userDataDir => path.join(userDataDir, 'recent-projects.json');
const normalizePath = value => String(value || '').trim().replace(/[\\/]+$/, '');
const nameOf = value => normalizePath(value).split(/[\\/]/).filter(Boolean).pop() || normalizePath(value);
const normalizeEntry = input => {
  const file = normalizePath(input && input.file) || undefined;
  const root = normalizePath(input && input.root) || (file ? path.dirname(file) : '');
  if (!root || root.length > 4096 || file && file.length > 4096 || /[\r\n\0]/.test(root + (file || ''))) return null;
  return { root, ...(file ? { file } : {}), name: String(input && input.name || nameOf(file || root)).slice(0, 160), openedAt: Number(input && input.openedAt) || Date.now() };
};
const same = (a, b) => {
  const key = value => normalizePath(value).toLowerCase();
  return key(a.file) && key(b.file) ? key(a.file) === key(b.file) : key(a.root) === key(b.root);
};
function read(userDataDir) {
  const file = fileOf(userDataDir);
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('最近项目文件过大');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(parsed) ? parsed : []).map(normalizeEntry).filter(Boolean).slice(0, MAX);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function write(userDataDir, list) {
  fs.mkdirSync(userDataDir, { recursive: true });
  atomicWriteFile(fileOf(userDataDir), JSON.stringify(list.slice(0, MAX), null, 2) + '\n');
}
function remember(userDataDir, input) {
  const entry = normalizeEntry(input); if (!entry) throw new Error('最近项目记录无效');
  const list = [entry, ...read(userDataDir).filter(item => !same(item, entry))].slice(0, MAX); write(userDataDir, list); return list;
}
function forget(userDataDir, input) {
  const entry = normalizeEntry(input); if (!entry) return read(userDataDir);
  const list = read(userDataDir).filter(item => !same(item, entry)); write(userDataDir, list); return list;
}
function clear(userDataDir) { write(userDataDir, []); return []; }
module.exports = { read, remember, forget, clear, normalizeEntry };
