import { useEffect, useState } from 'react';
import type { TrellisContext, TrellisProposal } from '../lib/trellisTypes';
import { useGraphStore } from '../store/graphStore';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { saveProject } from '../lib/projectActions';

export default function TrellisWritePanel({ root, context, disabled, reload }: { root: string; context: TrellisContext; disabled: boolean; reload: () => void }) {
  const [info, setInfo] = useState<{workspaces: string[]; statuses: string[]; proposals: Omit<TrellisProposal,'files'>[]}>({workspaces: [], statuses: [], proposals: []});
  const [kind, setKind] = useState('status');
  const [status, setStatus] = useState(context.task.status);
  const [developer, setDeveloper] = useState('');
  const [reason, setReason] = useState('');
  const [verification, setVerification] = useState('');
  const [next, setNext] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [specSource, setSpecSource] = useState('');
  const [specContent, setSpecContent] = useState('');
  const [scope, setScope] = useState('');
  const [proposal, setProposal] = useState<TrellisProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    void window.codenode?.trellisWriteInfo(root).then(result => { if (alive) { if (result.ok && result.value) setInfo(result.value); else setMessage(result.error || '写回能力读取失败'); } });
    return () => { alive = false; };
  }, [root, context.task.taskPath, proposal]);
  const specs = context.documents.filter(doc => doc.source.startsWith('.trellis/spec/') && doc.source.endsWith('.md'));
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const preview = () => void act(async () => {
    const spec = specs.find(doc => doc.source === specSource);
    const target = kind === 'spec' ? specSource : context.task.taskPath;
    const input = kind === 'status' ? { status, reason, acceptanceConfirmed: confirmed, expectedFingerprint: context.task.fingerprint }
      : kind === 'journal' ? { developer, summary: reason, verification, nextSteps: next, expectedFingerprint: context.task.fingerprint }
      : { content: specContent, reason, scope, expectedFingerprint: spec?.fingerprint };
    const result = await window.codenode!.trellisPropose(root, kind, target, input);
    if (!result.ok || !result.value) throw new Error(result.error || '无法生成修改建议');
    setProposal(result.value);
  });
  const apply = (action: string) => void act(async () => {
    if (!proposal) return;
    const result = await window.codenode!.trellisApply(root, proposal.id, action);
    if (!result.ok || !result.value) throw new Error(result.error || '写回失败');
    setProposal(result.value);
    setMessage(result.value.status === 'needs-recovery' ? '未全部成功：' + result.value.error : '事务状态：' + result.value.status);
  });
  const loadProposal = (id: string) => void act(async () => {
    if (!id) { setProposal(null); return; }
    const result = await window.codenode!.trellisProposalRead(root, id);
    if (!result.ok || !result.value) throw new Error(result.error || '事务读取失败');
    setProposal(result.value);
  });
  const canvas = () => void act(async () => {
    const owner = useSessionStore.getState().activeId;
    const result = await window.codenode!.trellisCanvas(root, context.task.taskPath);
    if (!result.ok || !result.value) throw new Error(result.error || '无法生成任务流程');
    if (useProjectStore.getState().root !== root || useSessionStore.getState().activeId !== owner) throw new Error('工程或画布已切换，停止添加流程');
    useGraphStore.getState().appendGraph(result.value);
    await saveProject();
    setMessage('已添加准备、实现、验证、审查阶段；在画布运行工作流，阶段使用 CodeNode 角色权限。');
  });
  return <details className="trellis-write-panel"><summary>任务写回与画布流程</summary>
    <button disabled={disabled || busy || !context.ready} onClick={canvas}>添加任务执行流程</button>
    <p>角色执行绑定到保存的资料快照；阶段结束不自动完成任务。写回需先预览，再点击应用。</p>
    <label>修改类型 <select aria-label="Trellis 修改类型" value={kind} disabled={disabled || busy} onChange={event => { setKind(event.target.value); setProposal(null); }}><option value="status">任务状态</option><option value="journal">工作日志</option><option value="spec">规范建议</option></select></label>
    {kind === 'status' && <>
      <label>状态 <select aria-label="Trellis 写回状态" value={status} onChange={event => setStatus(event.target.value)} disabled={disabled || busy}>{info.statuses.map(value => <option key={value}>{value}</option>)}</select></label>
      {status === 'completed' && <label><input type="checkbox" aria-label="确认 PRD 验收" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对全部 PRD 验收与未核验项，明确确认完成；下面填写人工证据</label>}
    </>}
    {kind === 'journal' && <>
      <label>开发者 <select aria-label="Trellis 日志开发者" value={developer} onChange={event => setDeveloper(event.target.value)}><option value="">选择已有工作区</option>{info.workspaces.map(name => <option key={name}>{name}</option>)}</select></label>
      <label>验证范围与结果<textarea aria-label="日志验证结果" value={verification} onChange={event => setVerification(event.target.value)} /></label>
      <label>遗留事项与下一步<textarea aria-label="日志下一步" value={next} onChange={event => setNext(event.target.value)} /></label>
    </>}
    {kind === 'spec' && <>
      <label>规范 <select aria-label="Trellis 规范路径" value={specSource} onChange={event => { setSpecSource(event.target.value); setSpecContent(specs.find(doc => doc.source === event.target.value)?.content || ''); }}><option value="">选择当前任务规范</option>{specs.map(doc => <option key={doc.source}>{doc.source}</option>)}</select></label>
      <label>适用范围<input aria-label="规范适用范围" value={scope} onChange={event => setScope(event.target.value)} /></label>
      <label>建议正文<textarea aria-label="规范建议正文" value={specContent} onChange={event => setSpecContent(event.target.value)} /></label>
    </>}
    <label>{kind === 'journal' ? '实现摘要' : '修改来源与证据'}<textarea aria-label="Trellis 写回说明" value={reason} onChange={event => setReason(event.target.value)} /></label>
    <button disabled={disabled || busy} onClick={preview}>预览修改</button>
    {!!info.proposals.filter(item => !['applied', 'rolled-back'].includes(item.status)).length && <label>未结束事务<select aria-label="Trellis 恢复事务" value={proposal?.id || ''} onChange={event => loadProposal(event.target.value)}><option value="">选择事务</option>{info.proposals.filter(item => !['applied', 'rolled-back'].includes(item.status)).map(item => <option key={item.id} value={item.id}>{item.kind} · {item.status} · {item.id.slice(0, 8)}</option>)}</select></label>}
    {proposal && <section aria-label="Trellis 修改预览"><p>{proposal.id} · {proposal.status}</p><pre>{JSON.stringify(proposal.details, null, 2)}</pre>
      {proposal.files.map(file => <details key={file.source}><summary>{file.source} · 原指纹 {file.beforeHash.slice(0, 12)}</summary><strong>修改前</strong><pre>{file.before ?? '（新文件）'}</pre><strong>修改后</strong><pre>{file.after}</pre></details>)}
      {proposal.status === 'proposed' && <button disabled={disabled || busy} onClick={() => apply('apply')}>应用预览修改</button>}
      {!['proposed', 'applied', 'rolled-back'].includes(proposal.status) && <><p role="alert">部分写入：{proposal.applied.join('、') || '无'} · {proposal.error}</p><button disabled={disabled || busy} onClick={() => apply('resume')}>恢复剩余写入</button><button disabled={disabled || busy} onClick={() => apply('rollback')}>按指纹回滚本次写入</button></>}
      {proposal.status === 'applied' && <button disabled={disabled || busy} onClick={reload}>重新读取写回结果</button>}
    </section>}
    {message && <p role="status">{message}</p>}
  </details>;
}
