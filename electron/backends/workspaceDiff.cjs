'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config/agent.backends.json');
const { shouldSkipDir, isSensitivePath } = require('../tools/fsCore.cjs');

// Content fingerprints work for non-Git projects and include uncommitted files.
// Excluded and unreadable data are never claimed to have been inspected.
function capture(root) {
  const entries = new Map(); const queue = ['']; let bytes = 0; let complete = true;
  while (queue.length && entries.size < config.snapshotFiles && bytes < config.snapshotBytes) {
    const relative = queue.pop() || '';
    let children;
    try { children = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }
    catch { complete = false; continue; }
    for (const child of children) {
      const file = path.join(relative, child.name); const normalized = file.replace(/\\/g, '/');
      if (child.isSymbolicLink()) { complete = false; continue; }
      if (child.isDirectory()) {
        if (!shouldSkipDir(child.name) && !['.codenode', 'release', '.cache'].includes(child.name)) queue.push(file);
      } else if (child.isFile() && !isSensitivePath(normalized)) {
        if (entries.size >= config.snapshotFiles || bytes >= config.snapshotBytes) { complete = false; break; }
        try {
          const stat = fs.statSync(path.join(root, file));
          if (bytes + stat.size > config.snapshotBytes) { complete = false; continue; }
          const data = fs.readFileSync(path.join(root, file)); bytes += data.length;
          entries.set(normalized, crypto.createHash('sha256').update(data).digest('hex'));
        } catch { complete = false; }
      }
    }
  }
  if (queue.length) complete = false;
  return { entries, complete };
}
function compare(before, after) {
  return { complete: before.complete && after.complete,
    scope: '当前项目内可读取文件；排除依赖、构建、运行数据、敏感文件及符号链接',
    files: [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort()
      .filter(file => before.entries.get(file) !== after.entries.get(file))
      .map(file => ({ path: file, kind: !before.entries.has(file) ? 'added' : !after.entries.has(file) ? 'deleted' : 'modified',
        before: before.entries.get(file) || null, after: after.entries.get(file) || null })) };
}
module.exports = { capture, compare };
