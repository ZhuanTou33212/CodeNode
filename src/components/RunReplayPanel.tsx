import { useEffect } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useReplayStore } from '../store/replayStore';
import type { ReplayEvent } from '../store/replayStore';

/** 审批事件的相位 → 中文（S7 的 ApprovalService 写入的 `event` 字段）。 */
function approvalPhase(event: unknown): string {
  switch (String(event || '')) {
    case 'approval_issued':
      return '已批准（签发令牌）';
    case 'approval_denied':
      return '用户拒绝';
    case 'approval_rejected':
      return '令牌被拒';
    case 'approval_consumed':
      return '令牌已消费';
    case 'approval_unavailable':
      return '无审批通道';
    case 'approval_error':
      return '审批通道异常';
    default:
      return String(event || '审批');
  }
}

/**
 * 事件 → 一行人类可读描述。只展示事件里**真实存在**的字段，缺就不显示（不补、不猜）。
 */
function describeEvent(event: ReplayEvent): string {
  const e = event as Record<string, any>;
  const parts: string[] = [];
  const push = (text: unknown) => {
    if (text === null || text === undefined || text === '') return;
    parts.push(String(text));
  };
  switch (String(e.kind)) {
    case 'tool':
      push(e.name || e.tool || 'tool');
      push(`ok=${e.ok}`);
      if (e.elapsedMs !== undefined) push(`${e.elapsedMs}ms`);
      if (e.repeated) push('结果重复');
      if (e.compressed) push('已压缩');
      if (e.malformed) push('参数不完整');
      if (e.attemptId) push(`尝试 ${e.attemptId}`);
      break;
    case 'run_state':
      push(e.type || 'run');
      push(`状态=${e.state || e.status || '未知'}`);
      if (e.reason) push(`原因=${e.reason}`);
      break;
    case 'checkpoint':
      push(e.type || 'checkpoint');
      if (e.tool) push(`工具=${e.tool}`);
      if (e.ok !== null && e.ok !== undefined) push(`ok=${e.ok}`);
      if (e.effect) push(`副作用=${e.effect}`);
      break;
    case 'side_effect':
      if (e.records !== undefined) push(`账本 ${e.records} 条`);
      if (e.latest) push(`最新=${e.latest.tool || ''}${e.latest.phase ? '/' + e.latest.phase : ''}`);
      break;
    case 'cost':
      push(e.call || 'cost');
      if (e.model) push(`模型=${e.model}`);
      if (e.tokens && e.tokens.total !== undefined) push(`tokens=${e.tokens.total}`);
      if (e.tokens && e.tokens.cached !== undefined) push(`命中=${e.tokens.cached}`);
      if (e.costUsd !== undefined) push(`$${Number(e.costUsd).toFixed(4)}`);
      break;
    case 'alert':
      if (e.level) push(e.level);
      if (e.code) push(e.code);
      if (e.message) push(e.message);
      break;
    case 'audit':
      push(String(e.entry || '').slice(0, 160));
      break;
    case 'approval':
      push(approvalPhase(e.event));
      if (e.what) push(`工具=${e.what}`);
      if (e.reason) push(`原因=${e.reason}`);
      break;
    default: {
      const { v, ts, kind, runId, turnId, toolCallId, attemptId, ...rest } = e;
      push(Object.keys(rest).length ? JSON.stringify(rest).slice(0, 140) : kind);
    }
  }
  return parts.filter(Boolean).join(' · ');
}

/** 事件类型的视觉分组（失败/审批/成本单独着色，其余走中性色）。 */
function kindTone(event: ReplayEvent): string {
  const kind = String(event.kind || '');
  if (kind === 'alert') return 'danger';
  if (kind === 'approval') {
    const phase = String((event as Record<string, any>).event || '');
    return phase === 'approval_issued' || phase === 'approval_consumed' ? 'accent2' : 'warn';
  }
  if (kind === 'cost') return 'accent2';
  if (kind === 'tool') return (event as Record<string, any>).ok === false ? 'warn' : 'muted';
  return 'muted';
}

function shortTime(ts: unknown): string {
  const text = String(ts || '');
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(text);
  return m ? m[1] : text.slice(0, 19);
}

/**
 * 运行回放（S8）：按 run 展示统一事件流的**时间线 + 摘要**。
 *
 * 数据来自 `window.codenode.replayEvents()`（主进程走 `eventBus.replayPayload`），
 * 与 `scripts/event-replay.cjs` 是同一份载荷 —— 界面与 CLI 不会各说各话。
 */
export default function RunReplayPanel() {
  const root = useProjectStore((s) => s.root);
  const runId = useReplayStore((s) => s.runId);
  const runs = useReplayStore((s) => s.runs);
  const events = useReplayStore((s) => s.events);
  const summary = useReplayStore((s) => s.summary);
  const total = useReplayStore((s) => s.total);
  const loading = useReplayStore((s) => s.loading);
  const error = useReplayStore((s) => s.error);
  const file = useReplayStore((s) => s.file);
  const load = useReplayStore((s) => s.load);
  const setRunId = useReplayStore((s) => s.setRunId);

  useEffect(() => {
    if (!root) return;
    void load(root);
  }, [root, load]);

  const failureCodes = summary ? Object.entries(summary.failureCodes) : [];
  const approvalTotal = summary
    ? summary.approvals.issued + summary.approvals.denied + summary.approvals.rejected
    : 0;

  return (
    <div className="dock-replay">
      <div className="dock-run-toolbar">
        <div>
          <strong>运行回放</strong>
          <span className="dock-file-meta">
            统一事件流 · 按 run 回放到工具调用 / 检查点 / 审批 / 成本（与 CLI 同一份数据）
          </span>
        </div>
        <div>
          <select
            value={runId ?? ''}
            onChange={(e) => {
              const next = e.target.value || null;
              setRunId(next);
              void load(root, { runId: next });
            }}
            disabled={loading || !runs.length}
          >
            <option value="">{runs.length ? '全部 run' : '暂无 run'}</option>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId}（{run.count} 条）
              </option>
            ))}
          </select>
          <button onClick={() => void load(root)} disabled={loading || !root}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
      </div>

      {error ? <div className="dock-empty">{error}</div> : null}

      {summary ? (
        <div className="dock-metrics">
          <span>事件 {summary.total}</span>
          <span>
            工具调用 {summary.toolCalls}
            {summary.toolFailures ? `（失败 ${summary.toolFailures}）` : ''}
          </span>
          {failureCodes.length ? (
            <span>失败码 {failureCodes.map(([code, n]) => `${code}×${n}`).join(', ')}</span>
          ) : null}
          {approvalTotal ? (
            <span>
              审批 签发 {summary.approvals.issued} / 拒绝 {summary.approvals.denied} / 令牌被拒{' '}
              {summary.approvals.rejected}
            </span>
          ) : null}
          {summary.costUsd ? <span>成本 ${summary.costUsd.toFixed(4)}</span> : null}
          {summary.tokens ? <span>token {summary.tokens}</span> : null}
          {summary.span.first ? (
            <span>
              {shortTime(summary.span.first)} → {shortTime(summary.span.last)}
            </span>
          ) : null}
        </div>
      ) : null}

      {summary ? (
        <div className="dock-replay-kinds">
          {Object.entries(summary.kinds).map(([kind, n]) => (
            <span className="dock-replay-chip" key={kind}>
              {kind} ×{n}
            </span>
          ))}
        </div>
      ) : null}

      {events.length ? (
        <div className="dock-replay-timeline">
          {events.map((event, index) => (
            <div
              className={`dock-replay-row ${kindTone(event)}`}
              key={`${event.ts || ''}-${event.kind}-${event.toolCallId || ''}-${index}`}
              title={`${event.kind}${event.runId ? ' · run=' + event.runId : ''}${event.turnId != null ? ' · turn=' + event.turnId : ''}${event.toolCallId ? ' · call=' + event.toolCallId : ''}`}
            >
              <span className="dock-replay-ts">{shortTime(event.ts)}</span>
              <span className="dock-replay-kind">{event.kind}</span>
              <span className="dock-replay-main">{describeEvent(event)}</span>
            </div>
          ))}
          {total > events.length ? (
            <div className="dock-replay-more">仅显示最近 {events.length} 条（共 {total} 条）</div>
          ) : null}
        </div>
      ) : (
        <div className="dock-empty">
          {loading ? '正在读取事件流…' : '还没有事件。跑一次 Agent（或工作流）后，这里会出现时间线。'}
        </div>
      )}

      {file ? <div className="dock-replay-file">{file}</div> : null}
    </div>
  );
}
