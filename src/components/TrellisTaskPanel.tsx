import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import type { TrellisContext, TrellisProject } from '../lib/trellisTypes';

export default function TrellisTaskPanel() {
  const root = useProjectStore(s => s.root);
  const conversationId = useSessionStore(s => s.memoryConversationId);
  const streaming = useSessionStore(s => s.streaming);
  const [project, setProject] = useState<TrellisProject | null>(null);
  const [context, setContext] = useState<TrellisContext | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const reload = useCallback(() => refresh(value => value + 1), []);
  useEffect(() => {
    let alive = true;
    setProject(null); setContext(null); setError('');
    if (!root || !window.codenode?.trellisProject) return;
    void (async () => {
      try {
        const result = await window.codenode!.trellisProject(root, conversationId);
        if (!alive) return;
        if (!result.ok || !result.value) throw new Error(result.error || 'Trellis 检测失败');
        setProject(result.value);
        if (result.value.selectedTask) {
          const details = await window.codenode!.trellisContext(root, result.value.selectedTask);
          if (!alive) return;
          if (!details.ok || !details.value) throw new Error(details.error || '任务读取失败');
          setContext(details.value);
        }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
    })();
    return () => { alive = false; };
  }, [root, conversationId, revision, streaming]);
  const select = async (taskPath: string) => {
    if (!root || busy || streaming) return;
    setBusy(true); setError('');
    try {
      const result = await window.codenode!.trellisSelect(root, conversationId, taskPath || null);
      if (!result.ok) throw new Error(result.error || '任务选择失败');
      reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  if (!project?.detected && !error) return null;
  return <details className="trellis-task-panel">
    <summary>兼容 Trellis · {context?.task.title || '选择任务'}{context && !context.ready ? ' · 资料待修复' : ''}</summary>
    <div className="trellis-task-content">
      <p>只读任务与规范 · 参考版本 {project?.referenceVersion} · Run 结束不自动完成任务</p>
      <label>当前对话任务 <select aria-label="Trellis 任务" disabled={busy || streaming} value={project?.selectedTask || ''} onChange={event => void select(event.target.value)}>
        <option value="">不绑定任务</option>
        {project?.selectedTask && !project.tasks.some(task => task.taskPath === project.selectedTask) && <option value={project.selectedTask}>原任务不可读取</option>}
        {project?.tasks.map(task => <option key={task.taskPath} value={task.taskPath}>{task.title} · {task.status}</option>)}
      </select></label>
      <button disabled={busy || streaming} onClick={reload}>重新读取资料</button>
      {error && <p role="alert">{error}</p>}
      {[...(project?.diagnostics || []), ...(context?.diagnostics || [])].map((item, index) => <p role="alert" key={index}>{item.source}：{item.error}</p>)}
      {context && <>
        <p>任务 ID：{context.task.id} · 上游状态：{context.task.status} · {context.tokens} tokens</p>
        <p>{context.ready ? '资料就绪；发送消息时由现有 Agent 执行' : '资料不完整，启动前需修复上述问题'}</p>
        <details><summary>本次使用的规范和资料 · {context.documents.length}</summary>
          {context.documents.map(doc => <details key={doc.source}><summary>{doc.source} · {doc.stages.join('/')} · {doc.fingerprint.slice(0, 12)}</summary><pre>{doc.content}</pre></details>)}
        </details>
        <details><summary>关联运行与验证证据 · {context.runs.length}（最近 200 次运行）</summary>
          {!context.runs.length && <p>尚未执行；PRD 验收项见任务资料。</p>}
          {context.runs.map(run => <div key={run.runId}><strong>{run.runId} · {run.status}</strong>
            <p>代码检查：{run.verification?.status || '未执行'} · {run.evidenceFresh ? '版本一致' : '尚无有效版本证据'}；检查范围不代表全部 PRD 验收通过。</p>
            {!!run.sourcesChanged.length && <p role="alert">任务资料已变化：{run.sourcesChanged.join('、')}；原运行沿用保存快照。</p>}
            {run.verification && <pre>{JSON.stringify(run.verification, null, 2)}</pre>}
          </div>)}
        </details>
      </>}
    </div>
  </details>;
}
