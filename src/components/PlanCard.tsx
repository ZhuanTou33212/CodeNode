import { useEffect } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useProjectStore } from '../store/projectStore';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { addPlanToCanvas, planItemsToSteps } from '../lib/planCanvas';

/**
 * PlanCard —— 任务清单卡片（`update_plan` 工具的计划）
 *
 * 为什么要有它：在此之前，计划只以三种「沿路」形式存在 —— ① 工具结果里的一段文本、
 * ② 每 N 轮才注入一次的进度提示（`progressEvery=0` 时根本没有）、③ 运行回放时间线里的一条事件。
 * 于是用户看不到「本次任务打算做几步、现在到第几步」，只能翻工具调用记录去数。
 *
 * 数据来源单一：主进程每次计划变化发一条 `kind:'plan'` 增量（见 electron/agent.cjs），
 * 界面只负责显示最新一份，不做本地推算。
 */
export function PlanCard() {
  const plan = useSessionStore((s) => s.plan);
  const updatedAt = useSessionStore((s) => s.planUpdatedAt);
  const sessionId = useSessionStore((s) => s.activeId);
  const runId = useSessionStore((s) => s.planRunId);
  const streaming = useSessionStore((s) => s.streaming);
  const alreadyImported = useGraphStore((s) => s.nodes.some(node => node.data.planSourceId === `${sessionId}:${runId || 'current'}`));
  const hasCachedPlan = useSessionStore((s) => !!(s.activeId && s.plansBySessionId[s.activeId]));
  const projectRoot = useProjectStore((s) => s.root);
  useEffect(() => {
    if (!sessionId || !projectRoot || hasCachedPlan || !window.codenode?.agentReadPlan) return;
    let live = true;
    window.codenode.agentReadPlan(projectRoot, sessionId).then((result) => {
      if (!live || !result.ok || !result.plan) return;
      const snapshot = result.plan;
      useSessionStore.getState().setPlanForSession(sessionId, {
        items: snapshot.items.map((item, index) => ({
          id: String(item.id || 'step-' + (index + 1)),
          step: String(item.step || ''),
          acceptanceCriteria: String(item.acceptanceCriteria || ''),
          status: (['pending', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(item.status) ? item.status : 'pending') as import('../store/sessionStore').PlanItem['status'],
          evidenceCallIds: Array.isArray(item.evidenceCallIds) ? item.evidenceCallIds : [],
          reason: item.reason,
          dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [],
          ownerTaskId: item.ownerTaskId,
        })),
        updatedAt: snapshot.updatedAt || null,
        runId: snapshot.runId || null,
      });
    }).catch(() => {});
    return () => { live = false; };
  }, [sessionId, projectRoot, hasCachedPlan]);
  if (!plan || plan.length === 0) return null;
  const done = plan.filter((i) => i.status === 'completed').length;
  const blocked = plan.filter((i) => i.status === 'blocked').length;
  const cancelled = plan.filter((i) => i.status === 'cancelled').length;
  const active = plan.find((i) => i.status === 'in_progress') || null;
  const allDone = done === plan.length;
  return (
    <div className={`ap-plan${allDone ? ' is-done' : ''}`} aria-label="任务清单">
      <div className="ap-plan-head">
        <span className="ap-plan-title">任务清单</span>
        <span className="ap-plan-count">
          {done}/{plan.length}
          {allDone ? ' 全部完成' : active ? ' 进行中：' + active.step : blocked ? ` 受阻 ${blocked}` : cancelled ? ` 已取消 ${cancelled}` : ''}
        </span>
        <span className="ap-plan-progress" aria-hidden="true">
          <span className="ap-plan-progress-bar" style={{ width: `${plan.length ? Math.round((done / plan.length) * 100) : 0}%` }} />
        </span>
      </div>
      <button type="button" className="ap-plan-canvas-action" disabled={streaming || alreadyImported} onClick={() => {
        if (!sessionId || !plan) return;
        const count = addPlanToCanvas(planItemsToSteps(plan), `${sessionId}:${runId || 'current'}`);
        useUiStore.getState().setToast(count ? `已生成 ${count} 个可编辑画布节点，请核对连线后再运行` : '本次计划已在画布中');
      }}>{alreadyImported ? '已生成画布节点' : '生成可编辑工作流'}</button>
      <ol className="ap-plan-items">
        {plan.map((item) => (
          <li key={item.id} className={`ap-plan-item st-${item.status}`}>
            <span className={`ap-plan-mark st-${item.status}`} aria-hidden="true">
              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '→' : item.status === 'blocked' ? '!' : item.status === 'cancelled' ? '−' : '·'}
            </span>
            <span className="ap-plan-step"><code>{item.id}</code> {item.step}</span>
            <span className="ap-plan-status">
              {item.status === 'completed' ? '已完成' : item.status === 'in_progress' ? '进行中' : item.status === 'blocked' ? '受阻' : item.status === 'cancelled' ? '已取消' : '待办'}
            </span>
            <span className="ap-plan-criteria">验收：{item.acceptanceCriteria || '旧版步骤，需补验收条件'}</span>
            {item.evidenceCallIds?.length ? <span className="ap-plan-evidence">证据调用：{item.evidenceCallIds.join('、')}</span> : null}
            {item.dependsOn?.length ? <span className="ap-plan-dependencies">前置步骤：{item.dependsOn.join('、')}</span> : null}
            {item.ownerTaskId ? <span className="ap-plan-owner">子代理：{item.ownerTaskId}</span> : null}
            {item.reason ? <span className="ap-plan-reason">说明：{item.reason}</span> : null}
          </li>
        ))}
      </ol>
      {updatedAt ? (
        <div className="ap-plan-meta">更新于 {new Date(updatedAt).toLocaleTimeString()}</div>
      ) : null}
    </div>
  );
}
