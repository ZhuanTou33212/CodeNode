/**
 * fileChanges.cjs —— 从工具调用记录里提取「改了哪些文件」（**唯一来源**）
 *
 * 此前 `electron/subagents.cjs` 里有一份局部实现（子代理信封的 refs / changedFiles 用它），
 * 现在主循环的进度检查层也要用同一口径 —— 两处各写一份迟早会漂移（一处算 bulk_edit 另一处不算）。
 *
 * 口径：
 *   - 只看**写文件**的工具（`WRITE_TOOLS`）：workbench_edit / save_project / remember 等虽然也是
 *     mutation，但不产生文件路径，不属于「已改动文件」；
 *   - `ok === false` 的调用不算（没写成的不能算改动）；
 *   - 路径取 `path / filePath / file / target`，`bulk_edit` 的 edits[] 里的路径也逐个算上；
 *   - 保序去重，默认最多 20 个（够交代进度，不至于把提示撑爆）。
 */
'use strict';

/** 会改动**文件**的工具（画布/标量类 mutation 不算「文件改动」） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bulk_edit', 'write_analysis_md']);

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return null;
  }
}

/**
 * @param {Array<any>} toolCalls 工具调用记录（`{name, args, ok}`）
 * @param {{limit?: number}} [options]
 * @returns {string[]} 相对路径（保序去重）
 */
function changedFilesFromToolCalls(toolCalls, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 20;
  const out = new Set();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call || call.ok === false || !WRITE_TOOLS.has(call.name)) continue;
    const parsed = parseArgs(call.args);
    if (!parsed) continue;
    const candidates = [];
    for (const key of ['path', 'filePath', 'file', 'target']) {
      if (parsed[key]) candidates.push(parsed[key]);
    }
    // bulk_edit：一次改多个文件
    for (const listKey of ['edits', 'files']) {
      const list = Array.isArray(parsed[listKey]) ? parsed[listKey] : [];
      for (const item of list) {
        if (!item) continue;
        const p = item.path || item.filePath || item.file || item.target;
        if (p) candidates.push(p);
      }
    }
    for (const p of candidates) {
      out.add(String(p));
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

module.exports = { WRITE_TOOLS, changedFilesFromToolCalls };
