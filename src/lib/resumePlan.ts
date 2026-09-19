/**
 * 续跑计划的人话化（#21：`needsReview` 分支丢弃后端已回传的 `plan`）。
 *
 * 后端在需要人工复核时返回 `{ ok:false, needsReview:true, plan }`（`electron/ipc/agent.cjs:218-220`），
 * 而修复前前端只取那个布尔：`plan.reason`（为什么要求复核）、`plan.warning`（复核什么）、
 * `plan.unknownEffects`（哪些工具的结果不可知）、`plan.pendingSteps`（还有哪些待办）被**整条丢弃** ——
 * 界面对用户说的只有一句「需要人工复核」，却不告诉他复核什么。
 *
 * 这里把「计划 → 界面文案」的全部判断收成一个纯函数：`chatStore`、`RunsPanel`、确认条
 * 都从它取字符串，界面与测试断言的是同一份实现（不是各写一遍的近似）。
 */

export type ResumeEffectKind = 'unknown' | 'write' | 'read' | string;

export interface ResumeStepLike {
  tool?: string;
  effect?: ResumeEffectKind;
  idemKey?: string | null;
}

export interface ResumePlanLike {
  ok?: boolean;
  runId?: string;
  mode?: 'complete' | 'auto' | 'review' | 'unknown' | string;
  reason?: string | null;
  warning?: string | null;
  error?: string | null;
  requiresReview?: boolean;
  unknownEffects?: ResumeStepLike[];
  pendingSteps?: ResumeStepLike[];
  completedSteps?: ResumeStepLike[];
  skippedByLedger?: { tool?: string; idemKey?: string | null; reason?: string }[];
}

export interface ResumePlanView {
  /** 恢复级别（auto / review / complete / unknown） */
  modeLabel: string;
  /** 后端给的复核理由；缺失时给「未说明」而不是空串，避免界面只剩一个词 */
  reason: string;
  /** 后端给的警告；缺失时为空串（警告本来就是可选的） */
  warning: string;
  /** 涉及「结果未知外部副作用」的工具名（去重、稳定顺序） */
  unknownTools: string[];
  /** 仍待执行的步骤描述 */
  pendingLabels: string[];
  /** 已被幂等账本跳过（续跑时不会再执行）的步骤数 */
  skippedCount: number;
  /** 是否必须人工复核（后端 requiresReview 或未知副作用非空） */
  requiresReview: boolean;
  /** 「了解风险，强制续跑」按钮的完整提示词（带上待办正文） */
  forceResumePrompt: string;
  /** 「按当前状态重试」按钮的完整提示词（不带旧检查点） */
  retryPrompt: string;
}

const MODE_LABELS: Record<string, string> = {
  auto: '自动续跑',
  review: '人工复核后续跑',
  complete: '无需续跑',
  unknown: '状态未知',
};

/** 去重且保持首次出现顺序 —— 界面里工具名的顺序必须稳定，否则读屏/测试都会抖 */
function uniqueTools(steps: ResumeStepLike[] | undefined): string[] {
  const out: string[] = [];
  for (const step of steps || []) {
    const name = String((step && step.tool) || '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function describeStep(step: ResumeStepLike): string {
  const tool = String((step && step.tool) || '未知步骤');
  const effect = String((step && step.effect) || '').trim();
  return effect ? `${tool}（${effect}）` : tool;
}

export function resumeModeLabel(mode: string | null | undefined): string {
  return MODE_LABELS[String(mode || '')] || String(mode || '状态未知');
}

export function summarizeResumePlan(plan: ResumePlanLike | null | undefined, prompt?: string): ResumePlanView {
  const p = plan || {};
  const unknownTools = uniqueTools(p.unknownEffects);
  const pendingLabels = (p.pendingSteps || []).map(describeStep);
  const body = String(prompt || p.reason || '（后端未给出续跑指令正文）');
  return {
    modeLabel: resumeModeLabel(p.mode),
    reason: String(p.reason || p.error || '未说明'),
    warning: String(p.warning || ''),
    unknownTools,
    pendingLabels,
    skippedCount: (p.skippedByLedger || []).length,
    // requiresReview 与 unknownEffects 必须联动：后端只说 requiresReview、或只给了未知副作用列表，
    // 两种形状都要落到「必须人工复核」，不能因为字段缺失就静默放行。
    requiresReview: p.requiresReview === true || unknownTools.length > 0,
    forceResumePrompt:
      '【已阅风险，强制续跑】我确认已经人工核对了上面列出的未知副作用（' +
      (unknownTools.join('、') || '无') +
      '）的当前状态，请在此前提下继续。\n\n' +
      body,
    retryPrompt: '【按当前状态重试】不要假设上一次未完成的副作用已经发生，请重新检查当前项目状态后再继续。\n\n' + body,
  };
}

/**
 * 确认条要显示的一行摘要（给 aria-live / toast 用）：必须含**理由**与**未知副作用的工具名**，
 * 否则用户看到的还是「需要人工复核」这句没有信息量的话。
 */
export function formatResumePlanNotice(plan: ResumePlanLike | null | undefined): string {
  const view = summarizeResumePlan(plan);
  const parts = ['需要人工复核：' + view.reason];
  if (view.unknownTools.length) parts.push('结果不可知的工具：' + view.unknownTools.join('、'));
  if (view.warning) parts.push(view.warning);
  if (view.pendingLabels.length) parts.push('待办 ' + view.pendingLabels.length + ' 步：' + view.pendingLabels.slice(0, 5).join('、'));
  if (view.skippedCount) parts.push('续跑时跳过已提交的写操作 ' + view.skippedCount + ' 步');
  return parts.join('；');
}
