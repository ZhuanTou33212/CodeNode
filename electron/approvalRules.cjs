/**
 * approvalRules.cjs —— 持久化的审批规则（对照 Claude Code 的 allow 规则 / Codex 的项目 trust）
 *
 * 短板（对照文档 §5 #6）：审批令牌此前**只存内存、单次有效**，于是同一个工具要批准第 N 次 ——
 * 用户要么每次点（疲劳），要么干脆把 `tools.confirm_writes` 关掉（等于对所有写入放开）。
 * 中间那档「这个工具在本项目里我信它」不存在。
 *
 * 本模块提供「按工具/能力记忆允许」的规则账本：
 *   - 文件：`<project>/.codenode/approvals.json`（**受保护路径**：写工具不能写它，见 shared.resolveInRoot）
 *   - 结构：`{version:1, rules:[{id, capability, tool, level, createdAt, source}]}`，上限 50 条
 *   - 匹配：所有已声明字段都要命中（capability 相等 + tool 相等 + level 相等或未声明）
 *   - 只对**注册表级**审批生效（那种 `what` 就是工具名）；shell 命令那种逐条确认**不记忆** ——
 *     因为「允许一条命令文本」很快就退化成「允许一类命令」，而 Windows 上没有内核兜底。
 *
 * 为什么必须把规则文件设为「写工具不可写」：模型如果能自己写这份文件，就等于**自己给自己发白名单**
 * （prompt injection 的一条现成路径）。规则只能由用户经界面按钮或手写文件产生。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');

const RULES_RELPATH = path.join('.codenode', 'approvals.json');
const MAX_RULES = 50;
/** 受保护路径（写工具一律拒绝）：这些文件是**授权面**，不能由 Agent 写 */
const PROTECTED_RELPATHS = [RULES_RELPATH, path.join('.codenode', 'permissions.json')];

function rulesFile(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), RULES_RELPATH);
}

/** 目标路径是否落在受保护清单里（相对项目根的任意写法都归一化后比较） */
function isProtectedWriteTarget(projectRoot, target) {
  let rel;
  try {
    rel = path.relative(path.resolve(projectRoot || '.'), path.resolve(target));
  } catch {
    return true;
  }
  const norm = rel.split(/[\\/]/).join('/');
  return PROTECTED_RELPATHS.some((p) => p.split(/[\\/]/).join('/') === norm);
}

/** @returns {{version: number, rules: Array<any>}} */
function readRules(projectRoot) {
  try {
    const file = rulesFile(projectRoot);
    if (!fs.existsSync(file)) return { version: 1, rules: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rules = parsed && Array.isArray(parsed.rules) ? parsed.rules.filter((r) => r && (r.tool || r.capability)) : [];
    return { version: 1, rules };
  } catch {
    // 坏文件当「没有规则」——注意这是**偏保守**的方向：只会多问一次，不会少问
    return { version: 1, rules: [] };
  }
}

function writeRules(projectRoot, rules) {
  const list = (Array.isArray(rules) ? rules : []).slice(-MAX_RULES);
  const file = rulesFile(projectRoot);
  atomicWriteFile(file, JSON.stringify({ version: 1, rules: list }, null, 2));
  return list;
}

/**
 * 加一条规则（同 capability+tool+level 已存在则返回 duplicate）。
 * @param {string} projectRoot
 * @param {{capability?: string|null, tool?: string|null, level?: string|null, source?: string}} rule
 */
function addRule(projectRoot, rule) {
  const capability = rule && rule.capability ? String(rule.capability) : null;
  const tool = rule && rule.tool ? String(rule.tool) : null;
  const level = rule && rule.level ? String(rule.level).toUpperCase() : null;
  if (!capability && !tool) return { ok: false, error: 'EMPTY_RULE' };
  const current = readRules(projectRoot);
  const dup = current.rules.find((r) => (r.capability || null) === capability && (r.tool || null) === tool && (r.level || null) === level);
  if (dup) return { ok: true, duplicate: true, id: dup.id, total: current.rules.length };
  const record = {
    id: 'rule-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    capability,
    tool,
    level,
    source: (rule && rule.source) || 'user',
    createdAt: new Date().toISOString(),
  };
  const list = writeRules(projectRoot, [...current.rules, record]);
  return { ok: true, duplicate: false, id: record.id, total: list.length };
}

/**
 * 命中检查（纯函数）。
 * @param {Array<any>} rules
 * @param {{capability?: string|null, tool?: string|null, level?: string|null}} req
 * @returns {any|null}
 */
function matchRule(rules, req) {
  const r = req || {};
  const list = Array.isArray(rules) ? rules : [];
  for (const rule of list) {
    if (!rule) continue;
    if (rule.capability && String(rule.capability) !== String(r.capability || '')) continue;
    if (rule.tool && String(rule.tool) !== String(r.tool || '')) continue;
    if (rule.level && String(rule.level).toUpperCase() !== String(r.level || '').toUpperCase()) continue;
    return rule;
  }
  return null;
}

/** 工具名形态（用于判断「这条审批能不能被记忆」：shell 命令文本不算） */
function isRememberableTool(tool) {
  return /^[a-z][a-z0-9_]{1,40}$/.test(String(tool || ''));
}

module.exports = {
  RULES_RELPATH,
  MAX_RULES,
  PROTECTED_RELPATHS,
  rulesFile,
  isProtectedWriteTarget,
  readRules,
  writeRules,
  addRule,
  matchRule,
  isRememberableTool,
};
