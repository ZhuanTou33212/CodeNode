/**
 * eval-limits.cjs —— 评测在两种模式下的「等效预算 / 配置覆盖 / 判据」（② 的真机适配底座）
 *
 * 抽成独立模块的原因：这三件事是**离线单测**的对象（不需要真机 Key、也不该由真机跑才能验证）。
 *
 * 口径：
 *   - `modelBudget` / `modelCfgOverride` / `modelChecks` 只在 `mode === 'model'` 时生效，
 *     离线语义**完全不受影响**（离线怎么判还怎么判）；
 *   - `modelCheckOverrides` 只允许微调**白名单内**的判据（目前仅 `steps-at-most`）：
 *     真机模型比脚本化模型多走一两步是正常的，但「压缩是否真的发生 / 文件是否真的改了」
 *     这类**实质判据永不放宽** —— 白名单之外的一律忽略（运行时兜底），
 *     同时 scripts/real-model-pr-test.cjs 会让写错的人**直接红**（不静默留下一条死配置）；
 *   - 步数只许**放宽**（不许比离线更严），且放宽幅度硬上限 **2 倍**。
 */
'use strict';

/** 允许按模式微调的判据类型（只放与模型行为天然相关的数值型判据） */
const OVERRIDABLE_CHECK_TYPES = new Set(['steps-at-most']);

/** 放宽幅度的硬上限（倍数） */
const MAX_LOOSEN_FACTOR = 2;

/**
 * 真机模式下的等效预算（离线用任务原本的 budget）。
 * @param {any} task
 * @param {string} mode
 */
function effectiveBudget(task, mode) {
  const base = (task && task.budget) || {};
  return mode === 'model' && task && task.modelBudget ? { ...base, ...task.modelBudget } : base;
}

/**
 * 真机模式下的等效配置覆盖（`limits.*` 做浅合并，其余键整体覆盖）。
 * @param {any} task
 * @param {string} mode
 */
function effectiveOverride(task, mode) {
  const base = (task && task.cfgOverride) || {};
  if (mode !== 'model' || !task || !task.modelCfgOverride) return base;
  const next = { ...base, ...task.modelCfgOverride };
  next.limits = { ...(base.limits || {}), ...((task.modelCfgOverride || {}).limits || {}) };
  return next;
}

/**
 * 真机模式下的等效判据。
 * @param {any} task
 * @param {string} mode
 */
function effectiveChecks(task, mode) {
  if (mode === 'model' && task && Array.isArray(task.modelChecks)) return task.modelChecks;
  const base = (task && task.checks) || [];
  if (mode !== 'model' || !task || !task.modelCheckOverrides) return base;
  return base.map((check) => {
    const patch = check && task.modelCheckOverrides[check.type];
    // 白名单之外：一律忽略（实质判据不会被真机配置放宽）
    if (!patch || !OVERRIDABLE_CHECK_TYPES.has(check.type)) return check;
    if (patch.max == null) return check;
    const baseMax = Number(check.max);
    const wanted = Number(patch.max);
    if (!Number.isFinite(baseMax) || !Number.isFinite(wanted)) return check;
    // 只许放宽、不许更严；放宽幅度不超过 2 倍
    const capped = Math.min(Math.max(wanted, baseMax), baseMax * MAX_LOOSEN_FACTOR);
    return { ...check, max: capped };
  });
}

module.exports = { effectiveBudget, effectiveChecks, effectiveOverride, OVERRIDABLE_CHECK_TYPES, MAX_LOOSEN_FACTOR };
