/**
 * 续跑复核条（#21）：后端在 `needsReview` 时回传的 `plan` 不再被丢掉。
 *
 * 修复前：界面只说一句「该运行存在结果未知的副作用，需要人工复核后才能继续」——
 * 既不说**为什么**要复核，也不说**复核什么**（哪些工具的结果不可知、还有哪些待办）。
 * 现在把 `reason` / `warning` / `unknownEffects` 的工具名 / `pendingSteps` 全部摆出来，
 * 并给出两个明确出口：
 *   ① 了解风险，强制续跑（`resumeForce:true`，走原检查点、跳过已提交的写）
 *   ② 按当前状态重试（丢弃旧检查点，重新检查项目现状）
 *
 * 该弹条只在「确实有需要复核的计划」时出现；两者都会先把弹条收起，避免重复发起。
 */
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { summarizeResumePlan } from '../../lib/resumePlan';
import { fireAndReport } from '../../lib/reportError';
import { useProjectStore } from '../../store/projectStore';
import { useSending } from '../../lib/useSending';

export default function ResumePlanNotice() {
  const notice = useUiStore((s) => s.resumePlanNotice);
  const send = useChatStore((s) => s.send);
  // 强制续跑 / 按当前状态重试同样走 `send`，所以同样要接忙碌守卫（#7 的续跑按钮同一条要求）
  const busy = useSending();
  if (!notice) return null;

  const view = summarizeResumePlan(notice.plan, notice.prompt);
  const report = (message: string) => useUiStore.getState().setToast(message);

  const forceResume = () => {
    const runId = String(notice.plan.runId || '');
    useUiStore.getState().setResumePlanNotice(null);
    void fireAndReport(
      () => send(view.forceResumePrompt, { resumeRunId: runId, resumeForce: true }),
      '强制续跑失败',
      report,
      (message) => useUiStore.getState().setToast(message)
    );
  };

  const retryFromState = () => {
    const prompt = view.retryPrompt;
    const runId = String(notice.plan.runId || '');
    useUiStore.getState().setResumePlanNotice(null);
    void fireAndReport(
      async () => {
        const root = useProjectStore.getState().root;
        const api = window.codenode;
        if (runId && root && api?.agentResumeStart) {
          const replacementRunId = 'retry-' + Date.now().toString(36);
          const marked = await api.agentResumeStart(root, runId, replacementRunId);
          if (!marked.ok) throw new Error(marked.error || '无法标记旧 Run');
        }
        await send(prompt);
      },
      '按当前状态重试失败',
      report,
      (message) => useUiStore.getState().setToast(message)
    );
  };

  return (
    <div className="ap-resume-review" role="alertdialog" aria-label="续跑需要人工复核">
      <div className="ap-resume-review-reason">
        续跑需要人工复核（{view.modeLabel}）：{view.reason}
      </div>
      {view.warning ? <div className="ap-resume-review-warning">{view.warning}</div> : null}
      {view.unknownTools.length ? (
        <div className="ap-resume-review-unknown">
          结果不可知的工具（系统不会自动重放，请人工核对当前状态）：
          <strong data-testid="resume-unknown-tools">{view.unknownTools.join('、')}</strong>
        </div>
      ) : null}
      {view.pendingLabels.length ? (
        <div className="ap-resume-review-pending">
          待办 {view.pendingLabels.length} 步：{view.pendingLabels.slice(0, 8).join('、')}
        </div>
      ) : null}
      {view.skippedCount ? <div className="ap-resume-review-skipped">续跑会跳过已提交的写操作 {view.skippedCount} 步</div> : null}
      <div className="ap-resume-review-actions">
        <button className="dock-danger" onClick={forceResume} disabled={busy} title={view.forceResumePrompt}>
          了解风险，强制续跑
        </button>
        <button onClick={retryFromState} disabled={busy} title={view.retryPrompt}>
          按当前状态重试
        </button>
        <button onClick={() => useUiStore.getState().setResumePlanNotice(null)}>先不续跑</button>
      </div>
    </div>
  );
}
