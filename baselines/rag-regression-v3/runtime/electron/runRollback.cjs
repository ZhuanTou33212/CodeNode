/**
 * runRollback.cjs —— Run 级文件回滚（增量审查 §4.2 的第三件事）
 *
 * 缺口：幂等账本记了「改了什么」（`idemKey` / actor / phase），但**没记「改之前是什么」**，
 * 也没有任何回滚入口 → 长任务跑偏时用户只能自己逐个文件手动还原（往往是几十个文件）。
 *
 * 现在的口径：
 *   - 写操作**第一次执行前**抓前像（`sideEffects.captureBeforeImage`，正文内容寻址存 blob）；
 *   - 本模块只做两件事：`planRollback`（**只读**，给出每个路径要 restore / delete / skip 与原因）
 *     与 `applyRollback`（真正写盘，逐项**写后校验**，越界路径一律拒绝）；
 *   - **不猜**：前像缺失、内容过大、blob 哈希对不上、别人在本 Run 之后又改过该文件 —— 一律如实
 *     报告并**拒绝自动改**（要 `force:true` 才动有冲突的项），绝不「尽力而为」地写半个文件。
 *
 * 判据见 scripts/run-rollback-test.cjs（含负向：只读 Run 无可回滚项、越界路径被拒、冲突需 force）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { SideEffectLedger, digest, fileStateDigest, beforeImageDir } = require('./sideEffects.cjs');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { resolveInRoot } = require('./tools/impl/shared.cjs');
const runStore = require('./runStore.cjs');

/**
 * 只读计划：本次 Run 里每个被写过的路径，回滚要做什么。
 * @param {any} projectRoot
 * @param {string} runId
 * @returns {{ok: boolean, runId: string, items: Array<any>, summary: {restore: number, delete: number, skip: number, conflict: number}, error?: string}}
 */
function planRollback(projectRoot, runId) {
  if (!projectRoot || !runId) return { ok: false, runId: String(runId || ''), items: [], summary: { restore: 0, delete: 0, skip: 0, conflict: 0 }, error: '缺少 projectRoot 或 runId' };
  const ledger = new SideEffectLedger({ projectRoot, scopeRunId: runId });
  const records = ledger.recordsForRollback();
  /** 同一路径可能被写多次：**前像取最早那一次**（回到 Run 开始前），冲突检测取最后一次写后的状态 */
  const byPath = new Map();
  for (const record of records) {
    const item = byPath.get(record.path);
    if (!item) {
      byPath.set(record.path, { path: record.path, tools: [record.tool], firstIntentAt: record.firstIntentAt, beforeImage: record.beforeImage, postStateDigest: record.postStateDigest });
      continue;
    }
    if (!item.tools.includes(record.tool)) item.tools.push(record.tool);
    item.postStateDigest = record.postStateDigest || item.postStateDigest;
  }

  const items = [];
  for (const entry of byPath.values()) {
    const image = entry.beforeImage;
    const currentDigest = fileStateDigest(projectRoot, entry.path);
    const base = {
      path: entry.path,
      tools: entry.tools,
      beforeSha256: (image && image.sha256) || null,
      existedBefore: image ? image.existed !== false && image.existed !== undefined : null,
      currentDigest,
      postStateDigest: entry.postStateDigest || null,
    };
    // 别人在本 Run 的最后一次写之后又改过它 → 回滚会覆盖别人的改动，必须显式 force
    const conflict = !!entry.postStateDigest && currentDigest !== entry.postStateDigest;
    if (!image) {
      items.push({ ...base, action: 'skip', restorable: false, reason: 'no-before-image', conflict });
      continue;
    }
    if (image.restorable === false) {
      items.push({ ...base, action: 'skip', restorable: false, reason: image.reason || 'not-restorable', conflict });
      continue;
    }
    if (image.existed === false) {
      items.push({ ...base, action: 'delete', restorable: true, conflict });
      continue;
    }
    items.push({ ...base, action: 'restore', restorable: true, conflict, blob: image.blob || null, bytes: image.bytes || null });
  }

  const summary = {
    restore: items.filter((item) => item.action === 'restore').length,
    delete: items.filter((item) => item.action === 'delete').length,
    skip: items.filter((item) => item.action === 'skip').length,
    conflict: items.filter((item) => item.conflict).length,
  };
  return { ok: true, runId, items, summary };
}

/**
 * 真正执行回滚。逐项：越界拒绝 → 校验前像 → 原子写回 / 删除 → **写后校验**。
 * @param {any} projectRoot
 * @param {string} runId
 * @param {{force?: boolean, audit?: Function}} [options]
 * @returns {{ok: boolean, runId: string, applied: Array<any>, refused: Array<any>, skipped: Array<any>, summary: any, error?: string}}
 */
function applyRollback(projectRoot, runId, options = {}) {
  const plan = planRollback(projectRoot, runId);
  if (!plan.ok) return { ok: false, runId: plan.runId, applied: [], refused: [], skipped: [], summary: plan.summary, error: plan.error };

  const applied = [];
  const refused = [];
  const skipped = [];
  const blobDir = beforeImageDir(projectRoot, runId);

  for (const item of plan.items) {
    if (item.action === 'skip') {
      skipped.push({ path: item.path, reason: item.reason });
      continue;
    }
    if (item.conflict && options.force !== true) {
      refused.push({ path: item.path, reason: 'conflict-needs-force' });
      continue;
    }
    let abs;
    try {
      // 注意：`resolveInRoot` 对越界路径是**返回 null**（不是抛异常，两种口径都要兜住）。
      // 这里必须显式判定，否则 `path.join(undefined, ...)` 之类的下游会在错误的位置上写。
      abs = resolveInRoot(projectRoot, item.path);
    } catch (error) {
      abs = null;
      refused.push({ path: item.path, reason: 'path-out-of-root:' + String((error && error.code) || (error && error.message) || '') });
      continue;
    }
    if (!abs) {
      refused.push({ path: item.path, reason: 'path-out-of-root' });
      continue;
    }
    try {
      if (item.action === 'delete') {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        const gone = !fs.existsSync(abs);
        (gone ? applied : refused).push({ path: item.path, action: 'delete', verified: gone });
        continue;
      }
      // restore：先校验前像本身没坏（fail-closed），再原子写回，最后**读回校验**
      const blobPath = path.join(blobDir, String(item.blob || ''));
      if (!item.blob || !fs.existsSync(blobPath)) {
        refused.push({ path: item.path, reason: 'before-image-blob-missing' });
        continue;
      }
      const content = fs.readFileSync(blobPath, 'utf8');
      if (digest(content) !== item.beforeSha256) {
        refused.push({ path: item.path, reason: 'before-image-blob-corrupt' });
        continue;
      }
      atomicWriteFile(abs, content);
      const after = digest(fs.readFileSync(abs, 'utf8'));
      const verified = after === item.beforeSha256;
      (verified ? applied : refused).push({ path: item.path, action: 'restore', verified, sha256: after });
    } catch (error) {
      refused.push({ path: item.path, reason: 'apply-failed:' + String((error && error.message) || error) });
    }
  }

  // ok 只在「**没有**任何拒绝、也没有任何跳过」时为真：跳过的项（前像过大/缺失）意味着
  // 工作区并没有回到 Run 之前的状态 —— 这时候报 ok 等于假绿，用户会以为已经干净了。
  const ok = refused.length === 0 && skipped.length === 0;
  const summary = { applied: applied.length, refused: refused.length, skipped: skipped.length, conflicts: plan.summary.conflict };
  try {
    runStore.appendEvent(projectRoot, runId, 'rollback_applied', {
      ok,
      force: options.force === true,
      applied: applied.map((item) => ({ path: item.path, action: item.action })),
      refused,
      skipped,
    });
  } catch {
    /* 事件写不进去不影响回滚结果本身（审计另外走 audit 回调） */
  }
  if (typeof options.audit === 'function') {
    try {
      options.audit('run_rollback', { runId, ok, ...summary, applied: applied.map((item) => item.path), refused, skipped });
    } catch {
      /* 审计失败不影响结果 */
    }
  }
  return { ok, runId, applied, refused, skipped, summary };
}

module.exports = { planRollback, applyRollback };
