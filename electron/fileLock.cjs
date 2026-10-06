'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STALE_LOCK_MS = 5 * 60 * 1000;

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function staleLock(lockPath, now) {
  let stat;
  try { stat = fs.statSync(lockPath); } catch (error) { return !!(error && error.code === 'ENOENT'); }
  if (now - stat.mtimeMs < STALE_LOCK_MS) return false;
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return !processAlive(owner.pid);
  } catch {
    // A partially written lock is reclaimed only after the stale interval.
    return true;
  }
}

function lockError(target) {
  const error = /** @type {Error & {code?: string}} */ (new Error('记忆文件正被另一个进程更新，请稍后重试：' + target));
  error.code = 'MEMORY_LOCKED';
  return error;
}

/**
 * Synchronous fail-fast lock for short JSON read/modify/write transactions.
 * If another process is writing, the caller receives MEMORY_LOCKED and can retry.
 */
function withFileLock(file, callback) {
  const target = path.resolve(file);
  const lockPath = target + '.lock';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const token = randomUUID();
  let fd;
  try {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || !staleLock(lockPath, Date.now())) throw lockError(target);
      try { fs.unlinkSync(lockPath); } catch {}
      try { fd = fs.openSync(lockPath, 'wx', 0o600); }
      catch { throw lockError(target); }
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
    fs.fsyncSync(fd);
    return callback();
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (owner.token === token) fs.unlinkSync(lockPath);
    } catch {}
  }
}

module.exports = { withFileLock, STALE_LOCK_MS };
