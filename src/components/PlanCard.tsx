import { useSessionStore } from '../store/sessionStore';

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
  if (!plan || plan.length === 0) return null;
  const done = plan.filter((i) => i.status === 'completed').length;
  const active = plan.find((i) => i.status === 'in_progress') || null;
  const allDone = done === plan.length;
  return (
    <div className={`ap-plan${allDone ? ' is-done' : ''}`} aria-label="任务清单">
      <div className="ap-plan-head">
        <span className="ap-plan-title">任务清单</span>
        <span className="ap-plan-count">
          {done}/{plan.length}
          {allDone ? ' 全部完成' : active ? ' 进行中：' + active.step : ''}
        </span>
        <span className="ap-plan-progress" aria-hidden="true">
          <span className="ap-plan-progress-bar" style={{ width: `${plan.length ? Math.round((done / plan.length) * 100) : 0}%` }} />
        </span>
      </div>
      <ol className="ap-plan-items">
        {plan.map((item, i) => (
          <li key={i} className={`ap-plan-item st-${item.status}`}>
            <span className={`ap-plan-mark st-${item.status}`} aria-hidden="true">
              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '→' : '·'}
            </span>
            <span className="ap-plan-step">{item.step}</span>
            <span className="ap-plan-status">
              {item.status === 'completed' ? '已完成' : item.status === 'in_progress' ? '进行中' : '待办'}
            </span>
          </li>
        ))}
      </ol>
      {updatedAt ? (
        <div className="ap-plan-meta">更新于 {new Date(updatedAt).toLocaleTimeString()}</div>
      ) : null}
    </div>
  );
}
