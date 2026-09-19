import { useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStore } from '../store/graphStore';
import { useProjectStore } from '../store/projectStore';
import { useCheckpointStore } from '../store/checkpointStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { saveProject } from '../lib/projectActions';
import { useChatStore } from '../store/chatStore';
import { useSending } from '../lib/useSending';
import { fireAndReport, reportError } from '../lib/reportError';
import { summarizeResumePlan } from '../lib/resumePlan';
import RunReplayPanel from './RunReplayPanel';
import type { Node } from '@xyflow/react';

type DockTab = 'editor' | 'diff' | 'terminal' | 'runs' | 'checkpoints' | 'extensions';
type RunItem = { id: string; label: string; type: string; status: 'pending' | 'running' | 'done' | 'failed' | 'blocked'; output?: string };
type AgentRun = { runId: string | null; status: string; state?: string | null; startedAt: string | null; eventCount: number };
/**
 * 哪些 Run 值得出现在「可续跑」列表里（第 2 项缺陷）：
 *   - `interrupted`：进程/连接中断，本来就在列；
 *   - `state === 'LIMIT_REACHED'`：**跑到上限停下**（status 仍是 error，靠 state 区分）——
 *     这些 Run 有检查点、续跑计划通常也是 auto，却被 `status === 'interrupted'` 的过滤挡在门外，
 *     用户只能看到一句「任务未完成」，连续跑按钮都找不到。
 */
function isResumableRun(run: AgentRun) {
  return run.status === 'interrupted' || run.state === 'LIMIT_REACHED';
}
type ResumePlan = {
  runId?: string;
  prompt?: string;
  warning?: string;
  error?: string;
  ok: boolean;
  mode?: 'complete' | 'auto' | 'review' | 'unknown';
  reason?: string;
  requiresReview?: boolean;
  pendingSteps?: { tool: string; effect: string; idemKey: string | null }[];
  completedSteps?: { tool: string; idemKey: string | null; at: string | null }[];
  skippedByLedger?: { tool: string; idemKey: string | null; reason: string }[];
  unknownEffects?: { tool: string; effect: string }[];
};

type MetricsView = {
  run: CostCountersDto;
  today: CostCountersDto;
  queue?: { active: number; waiting: number; maxWaitMs: number } | null;
};

const TABS: { id: DockTab; label: string }[] = [
  { id: 'editor', label: '代码编辑器' },
  { id: 'diff', label: 'Diff' },
  { id: 'terminal', label: '终端' },
  { id: 'runs', label: '工作流运行' },
  { id: 'checkpoints', label: '检查点' },
  { id: 'extensions', label: '扩展' },
];

function lineDiff(before: string, after: string) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const rows: { kind: 'same' | 'add' | 'remove'; text: string; line?: number }[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) rows.push({ kind: 'same', text: a[i] ?? '', line: i + 1 });
    else {
      if (a[i] !== undefined) rows.push({ kind: 'remove', text: a[i], line: i + 1 });
      if (b[i] !== undefined) rows.push({ kind: 'add', text: b[i], line: i + 1 });
    }
  }
  return rows;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightCode(value: string) {
  const token = /(\/\/[^\n]*|#[^\n]*|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|new|true|false|null|undefined|try|catch|throw|interface|type|public|private|static|void|boolean|string|number)\b|\b\d+(?:\.\d+)?\b)/g;
  let result = '';
  let last = 0;
  value.replace(token, (match, _unused, offset) => {
    result += escapeHtml(value.slice(last, offset));
    const cls = /^(\/\/|#)/.test(match) ? 'comment' : /^("|'|`)/.test(match) ? 'string' : /^\d/.test(match) ? 'number' : 'keyword';
    result += `<span class="tok-${cls}">${escapeHtml(match)}</span>`;
    last = offset + match.length;
    return match;
  });
  return result + escapeHtml(value.slice(last));
}

function diagnoseCode(path: string, value: string) {
  const problems: { line: number; message: string }[] = [];
  const stack: { char: string; line: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  value.split(/\r?\n/).forEach((line, index) => {
    for (const char of line) {
      if ('([{'.includes(char)) stack.push({ char, line: index + 1 });
      else if (')]}'.includes(char)) {
        const top = stack.pop();
        if (!top || top.char !== pairs[char]) problems.push({ line: index + 1, message: `括号不匹配：${char}` });
      }
    }
  });
  for (const item of stack) problems.push({ line: item.line, message: `缺少闭合括号：${item.char}` });
  if (/\.json$/i.test(path) && value.trim()) {
    try { JSON.parse(value); } catch (error) { problems.push({ line: 1, message: `JSON 解析失败：${String(error).replace(/^SyntaxError:\s*/, '').slice(0, 120)}` }); }
  }
  return problems.slice(0, 30);
}

function commandFromNode(node: Node): string | null {
  const prompt = String((node.data as Record<string, unknown> | undefined)?.prompt || '').trim();
  const explicit = prompt.match(/^(?:run:|\$)\s*(.+)$/i);
  if (explicit?.[1]) return explicit[1].trim();
  if (/^(npm|npx|node|git|python3?|py|java|javac|mvn|mvnw|gradle|go|cargo|cmd|powershell|pwsh)\b/i.test(prompt)) return prompt;
  return null;
}

function topoNodes(nodes: Node[], edges: { source: string; target: string }[]) {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const outgoing = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: Node[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const node = nodes.find((n) => n.id === id);
    if (node) order.push(node);
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  for (const node of nodes) if (!order.some((x) => x.id === node.id)) order.push(node);
  return order;
}

function EditorPanel() {
  const selected = useProjectStore((s) => s.selected);
  const draft = useProjectStore((s) => s.draft);
  const searchMatches = useProjectStore((s) => s.searchMatches);
  const searching = useProjectStore((s) => s.searching);
  const searchProject = useProjectStore((s) => s.searchProject);
  const openFile = useProjectStore((s) => s.openFile);
  const dirty = useProjectStore((s) => s.dirty);
  const updateDraft = useProjectStore((s) => s.updateDraft);
  const saveSelected = useProjectStore((s) => s.saveSelected);
  const revertDraft = useProjectStore((s) => s.revertDraft);
  const conflict = useProjectStore((s) => s.conflict);
  const forceSaveSelected = useProjectStore((s) => s.forceSaveSelected);
  const acceptExternalFile = useProjectStore((s) => s.acceptExternalFile);
  const mergeExternalFile = useProjectStore((s) => s.mergeExternalFile);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<string[]>([]);
  const [showCompletions, setShowCompletions] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  // 幂等追加：不能在依赖里再读 tabs，否则 StrictMode 双次执行 / 陈旧闭包会重复插入同一路径
  useEffect(() => {
    if (selected?.relPath) {
      setTabs((list) => (list.includes(selected.relPath) ? list : [...list, selected.relPath]));
    }
  }, [selected?.relPath]);

  const save = async () => {
    setSaving(true);
    const ok = await saveSelected();
    setSaving(false);
    if (ok) useUiStore.getState().setToast(`已保存 ${selected?.relPath || '文件'}`);
  };

  // Hook 必须在任何条件 return 之前调用：此前 useMemo 被放在 `if (!selected) return`
  // 之后，未选中文件时少调一个 Hook、选中后多调一个，React 会抛
  // "Rendered more hooks than during the previous render." 并卸载整棵树 -> 界面全白。
  const problems = useMemo(
    () => (selected ? diagnoseCode(selected.relPath, draft) : []),
    [selected, draft]
  );

  if (!selected) return <div className="dock-empty">从左侧项目树点击文件，开始编辑。支持多文件标签、保存、撤销和 Diff 对比。</div>;
  const lines = draft.split(/\r?\n/).length;
  const language = selected.relPath.split('.').pop()?.toUpperCase() || 'TEXT';
  const completionItems = ['const', 'function', 'return', 'async', 'await', 'if', 'else', 'for', 'try', 'catch', 'console.log'];
  const closeTab = (path: string) => {
    const next = tabs.filter((item) => item !== path);
    setTabs(next);
    if (path === selected.relPath && next.length) void openFile(next[next.length - 1]);
  };
  return (
    <div className="dock-editor">
      <div className="dock-editor-tabs">{tabs.map((path) => <button key={path} className={path === selected.relPath ? 'active' : ''} onClick={() => { void openFile(path); }}><span>{path.split('/').pop()}</span><i onClick={(e) => { e.stopPropagation(); closeTab(path); }}>×</i></button>)}</div>
      <div className="dock-file-head">
        <span className="dock-file-path">{selected.relPath}{dirty ? ' · 未保存' : ''}</span>
        <span className="dock-language">{language}</span>
        <span className="dock-file-meta">{lines} 行 · {draft.length} 字符</span>
        <div className="dock-search"><input value={query} placeholder="搜索项目…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void searchProject(query); }} /><button onClick={() => void searchProject(query)} disabled={!query.trim() || searching}>{searching ? '…' : '查找'}</button></div>
        <button onClick={revertDraft} disabled={!dirty}>撤销修改</button>
        <button className="dock-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? '保存中…' : '保存文件'}</button>
      </div>
      {query.trim() && <div className="dock-search-results">{searchMatches.length ? searchMatches.map((match) => <button key={`${match.path}:${match.line}`} onClick={() => { void openFile(match.path); }}>{match.path}:{match.line}<span>{match.text}</span></button>) : <span>{searching ? '搜索中…' : '没有匹配结果'}</span>}</div>}
      {conflict && <div className="dock-conflict"><span>文件在外部被修改，当前草稿未覆盖外部内容。</span><button onClick={mergeExternalFile}>三方合并</button><button onClick={acceptExternalFile}>载入外部版本</button><button className="dock-danger" onClick={() => void forceSaveSelected()}>强制覆盖外部版本</button></div>}
      <div className="dock-problems"><strong>{problems.length ? `问题 ${problems.length}` : '无问题'}</strong>{problems.map((problem, index) => <span key={index}>L{problem.line} {problem.message}</span>)}<button onClick={() => setShowCompletions((value) => !value)}>补全 ⌘Space</button></div>
      {showCompletions && <div className="dock-completions">{completionItems.map((item) => <button key={item} onClick={() => { const el = editorRef.current; if (!el) return; const start = el.selectionStart; updateDraft(draft.slice(0, start) + item + draft.slice(el.selectionEnd)); setShowCompletions(false); requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + item.length, start + item.length); }); }}>{item}</button>)}</div>}
      <div className="dock-code-wrap">
        <div className="dock-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
        <div className="dock-code-surface">
          <pre ref={highlightRef} className="dock-code-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightCode(draft) + '\n' }} />
          <textarea
            ref={editorRef}
            className="dock-code-editor"
            value={draft}
            spellCheck={false}
            onChange={(e) => updateDraft(e.target.value)}
            onScroll={(e) => { if (highlightRef.current) { highlightRef.current.scrollTop = e.currentTarget.scrollTop; highlightRef.current.scrollLeft = e.currentTarget.scrollLeft; } }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
              if ((e.metaKey || e.ctrlKey) && e.code === 'Space') { e.preventDefault(); setShowCompletions((value) => !value); }
              if (e.key === 'Tab') { e.preventDefault(); const el = e.currentTarget; const start = el.selectionStart; const end = el.selectionEnd; updateDraft(draft.slice(0, start) + '  ' + draft.slice(end)); requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2)); }
            }}
          />
        </div>
      </div>
    </div>
  );
}

function DiffPanel() {
  const selected = useProjectStore((s) => s.selected);
  const draft = useProjectStore((s) => s.draft);
  const rows = useMemo(() => selected ? lineDiff(selected.content, draft) : [], [selected, draft]);
  const changed = rows.filter((r) => r.kind !== 'same').length;
  if (!selected) return <div className="dock-empty">先从项目树打开一个文件，再查看修改对比。</div>;
  return (
    <div className="dock-diff">
      <div className="dock-file-head"><span className="dock-file-path">{selected.relPath}</span><span className="dock-file-meta">{changed ? `${changed} 处变更` : '没有未保存变更'}</span></div>
      <pre className="dock-diff-code">{rows.map((row, i) => <span key={i} className={`dock-diff-row ${row.kind}`}><b>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}</b>{row.text || ' '}{'\n'}</span>)}</pre>
    </div>
  );
}

function TerminalPanel() {
  const root = useProjectStore((s) => s.root);
  const [command, setCommand] = useState('npm run build');
  const [output, setOutput] = useState('终端已就绪。命令会在当前项目根目录执行。');
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [stdin, setStdin] = useState('');
  useEffect(() => {
    const api = window.codenode;
    if (!api?.onProjectCommandEvent) return;
    return api.onProjectCommandEvent((event) => {
      if (!event.sessionId || event.sessionId !== sessionId) return;
      if (event.kind === 'output') setOutput((v) => v + (event.text || ''));
      if (event.kind === 'error') { setOutput((v) => v + `\n错误：${event.error || '未知错误'}\n`); setRunning(false); setSessionId(null); }
      if (event.kind === 'done') { setOutput((v) => v + `\n[退出码 ${event.exitCode ?? '-'}]${event.timedOut ? ' 超时' : ''}\n`); setRunning(false); setSessionId(null); }
    });
  }, [sessionId]);
  const run = async () => {
    if (!root || !command.trim() || running || !window.codenode?.startProjectCommand) return;
    setRunning(true);
    setOutput((v) => `${v}\n\n$ ${command.trim()}\n`);
    setHistory((list) => [command.trim(), ...list.filter((x) => x !== command.trim())].slice(0, 20));
    const res = await window.codenode.startProjectCommand(root, command.trim(), 180);
    if (!res.ok || !res.sessionId) { setOutput((v) => `${v}\n错误：${res.error || '无法启动命令'}\n`); setRunning(false); return; }
    setSessionId(res.sessionId);
  };
  const stop = async () => { if (sessionId && window.codenode?.stopProjectCommand) await window.codenode.stopProjectCommand(sessionId); };
  const sendInput = async () => { if (!sessionId || !stdin.trim() || !window.codenode?.sendProjectCommandInput) return; await window.codenode.sendProjectCommandInput(sessionId, stdin); setOutput((v) => `${v}> ${stdin}\n`); setStdin(''); };
  return (
    <div className="dock-terminal">
      <div className="dock-terminal-head"><span>{root || '未打开项目'}</span><span className="dock-file-meta">支持构建、测试、Git 和项目工具命令</span></div>
      <pre className="dock-terminal-output">{output}</pre>
      {running && <div className="dock-terminal-input dock-process-stdin"><span>&gt;</span><input value={stdin} onChange={(e) => setStdin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendInput(); }} placeholder="向运行中的进程发送输入…" /><button onClick={() => void sendInput()} disabled={!stdin.trim()}>发送</button></div>}
      <div className="dock-terminal-input"><span>$</span><input value={command} disabled={!root || running} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} placeholder="例如 npm test" />{running ? <button onClick={() => void stop()}>停止</button> : <button className="dock-primary" onClick={() => void run()} disabled={!root || !command.trim()}>运行</button>}</div>
      {history.length > 0 && <div className="dock-command-history">最近命令：{history.map((item) => <button key={item} onClick={() => setCommand(item)}>{item}</button>)}</div>}
    </div>
  );
}

function RunsPanel() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const runFlow = useGraphStore((s) => s.runFlow);
  const root = useProjectStore((s) => s.root);
  const createCheckpoint = useCheckpointStore((s) => s.create);
  const [items, setItems] = useState<RunItem[]>([]);
  const [running, setRunning] = useState(false);
  const cancel = useRef(false);
  const runStateKey = `codenode.runstate.${root || 'no-project'}.${useSessionStore((s) => s.activeId) || 'canvas'}`;
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [resumePlan, setResumePlan] = useState<ResumePlan | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [metrics, setMetrics] = useState<{ cost?: MetricsView; sandbox?: { description: string; backend: string; degraded: string[] }; alerts?: AlertDto[] } | null>(null);
  const sendChat = useChatStore((s) => s.send);
  const stopAll = useChatStore((s) => s.stopAll);
  // #7：续跑按钮必须和输入框共用同一个忙碌守卫 —— 修复前它绕过 `busy` 直接 `sendChat`，
  // 于是第二个请求会覆盖 `requestId`（旧请求再也停不掉、两条流写进同一气泡）。
  const sending = useSending();
  const busy = sending || recoveryBusy;
  const report = (message: string) => useUiStore.getState().setToast(message);
  const view = resumePlan ? summarizeResumePlan(resumePlan, resumePlan.prompt) : null;

  useEffect(() => {
    setItems(nodes.map((n) => ({ id: n.id, label: String((n.data as Record<string, unknown>)?.label || n.id), type: n.type || 'task', status: String((n.data as Record<string, unknown>)?.status || 'pending') as RunItem['status'] })));
    try { setResumeAvailable(!!localStorage.getItem(runStateKey)); } catch {}
  }, [nodes.length, runStateKey]);

  useEffect(() => {
    let alive = true;
    if (!root || !window.codenode?.agentRuns) { setAgentRuns([]); return () => { alive = false; }; }
    void window.codenode.agentRuns(root).then((runs) => {
      if (alive) setAgentRuns(runs.filter(isResumableRun));
    }).catch(() => { if (alive) setAgentRuns([]); });
    return () => { alive = false; };
  }, [root]);

  useEffect(() => {
    let alive = true;
    if (!root || !window.codenode?.agentMetrics) return () => { alive = false; };
    const load = () => {
      void window.codenode
        ?.agentMetrics(root)
        .then((res) => {
          if (!alive || !res?.ok) return;
          setMetrics({ cost: res.cost, sandbox: res.sandbox, alerts: res.firedAlerts?.length ? res.firedAlerts : res.alertHistory?.slice(-3) });
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 20000);
    const off = window.codenode.onAgentAlert?.((alert) => {
      useUiStore.getState().setToast((alert.severity === 'critical' ? '【严重】' : '【告警】') + alert.message);
    });
    return () => {
      alive = false;
      clearInterval(timer);
      off?.();
    };
  }, [root]);

  const inspectResume = async (runId: string) => {
    if (!root || !window.codenode?.agentResumePlan) return;
    setRecoveryBusy(true);
    try { setResumePlan(await window.codenode.agentResumePlan(root, runId)); }
    catch (e) { reportError('查看恢复计划失败', e, report); }
    finally { setRecoveryBusy(false); }
  };

  /** 自动断点续跑：走完整检查点/幂等账本链路（跳过已提交的写操作），不需要用户重述任务 */
  const autoResume = () => {
    if (busy || !resumePlan?.ok || !resumePlan.runId) return;
    setRecoveryBusy(true);
    // #25(a)：`void asyncFn()` 会把 IPC reject 吞进 devtools —— 统一走 fireAndReport，
    // 失败一定变成用户可见的提示（含「点了没反应」的那一类）。
    void fireAndReport(
      async () => {
        // #21：后端 needsReview 时回传的 plan 留在这里显示，别把「复核什么」丢掉
        const res = await sendChat('（自动断点续跑）' + (resumePlan.prompt || ''), { resumeRunId: resumePlan.runId });
        if (res.reply) setResumePlan(null);
        if (root && window.codenode?.agentRuns) setAgentRuns((await window.codenode.agentRuns(root)).filter(isResumableRun));
      },
      '自动续跑失败',
      report
    ).finally(() => setRecoveryBusy(false));
  };

  const retryResume = () => {
    if (busy || !resumePlan?.ok || !resumePlan.prompt) return;
    setRecoveryBusy(true);
    void fireAndReport(
      async () => {
        const replacementRunId = 'retry-' + Date.now().toString(36);
        const marked = root && window.codenode?.agentResumeStart
          ? await window.codenode.agentResumeStart(root, resumePlan.runId || '', replacementRunId)
          : { ok: false, error: '恢复接口不可用' };
        if (!marked.ok) throw new Error(marked.error || '无法标记旧 Run');
        await sendChat('这是一次人工确认后的 Agent 任务重试。请重新检查当前项目状态，不要假设上一次未完成的副作用已经发生。\n\n' + resumePlan.prompt);
        setResumePlan(null);
        if (root && window.codenode?.agentRuns) setAgentRuns((await window.codenode.agentRuns(root)).filter(isResumableRun));
      },
      '按当前状态重试失败',
      report
    ).finally(() => setRecoveryBusy(false));
  };

  /** 了解风险后强制续跑（#21 的出口①）：带 resumeForce，主进程不再拦 needsReview */
  const forceResume = () => {
    if (busy || !resumePlan || !resumePlan.runId) return;
    setRecoveryBusy(true);
    void fireAndReport(
      async () => {
        useUiStore.getState().setResumePlanNotice(null);
        await sendChat(view ? view.forceResumePrompt : '（已阅风险，强制续跑）', { resumeRunId: resumePlan.runId, resumeForce: true });
        setResumePlan(null);
        if (root && window.codenode?.agentRuns) setAgentRuns((await window.codenode.agentRuns(root)).filter(isResumableRun));
      },
      '强制续跑失败',
      report
    ).finally(() => setRecoveryBusy(false));
  };

  /** 立即停掉所有在跑的 Agent 请求（#7：「全部停止」出口） */
  const stopEverything = () => {
    const ids = stopAll();
    if (!ids.length) report('当前没有正在运行的 Agent 请求');
  };

  const start = async () => {
    if (running || !nodes.length) return;
    cancel.current = false;
    createCheckpoint('运行前自动检查点');
    const order = topoNodes(nodes, edges);
    let saved: { completed?: string[]; outputs?: Record<string, string> } = {};
    try { saved = JSON.parse(localStorage.getItem(runStateKey) || '{}'); } catch {}
    const completed = new Set(saved.completed || []);
    setRunning(true);
    setItems(order.map((node) => ({ id: node.id, label: String((node.data as Record<string, unknown>)?.label || node.id), type: node.type || 'task', status: completed.has(node.id) ? 'done' : 'pending', output: saved.outputs?.[node.id] })));
    for (const node of order) {
      if (cancel.current) break;
      if (completed.has(node.id)) continue;
      const label = String((node.data as Record<string, unknown>)?.label || node.id);
      updateNodeData(node.id, { status: 'running' });
      setItems((list) => list.map((x) => x.id === node.id ? { ...x, status: 'running' } : x));
      const command = commandFromNode(node);
      const prompt = String((node.data as Record<string, unknown>)?.prompt || '').trim();
      let output = command ? `运行：${command}` : '';
      let failed = false;
      if (['start', 'end', 'file', 'object', 'scope'].includes(node.type || '')) {
        output = '结构节点已通过';
      } else if (command && root && window.codenode?.runProjectCommand) {
        const res = await window.codenode.runProjectCommand(root, command, 180);
        output += `\n${res.output || ''}`;
        failed = !res.ok;
      } else if (!command && prompt && root && window.codenode?.agentChat && ['task', 'stage', 'tool'].includes(node.type || '')) {
        const requestId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const res = await window.codenode.agentChat({
          projectRoot: root,
          prompt: `执行工作流节点「${label}」：\n${prompt}\n完成后只返回本节点的执行结果与验证信息。`,
          history: [],
          canvasSummary: JSON.stringify(nodes.map((item) => ({ id: item.id, type: item.type, label: (item.data as Record<string, unknown>)?.label, status: (item.data as Record<string, unknown>)?.status }))),
          nodeId: node.id,
          requestId,
          document: { root: useGraphStore.getState().getDocument() },
          projectFile: useProjectStore.getState().projectFile || undefined,
        });
        output = `Agent：${res.reply || res.error || '无返回内容'}`;
        failed = !res.ok;
      } else if (!command && prompt) {
        output = '需要项目根目录和 Agent 配置才能执行此节点';
        failed = true;
      } else {
        output = '无执行内容：该节点需要填写 Prompt 或以 run:/$/命令开头';
        failed = true;
      }
      updateNodeData(node.id, { status: failed ? 'failed' : 'done' });
      setItems((list) => list.map((x) => x.id === node.id ? { ...x, status: failed ? 'failed' : 'done', output } : x));
      if (!failed) completed.add(node.id);
      try { localStorage.setItem(runStateKey, JSON.stringify({ completed: [...completed], outputs: { ...(saved.outputs || {}), [node.id]: output }, updatedAt: Date.now() })); } catch {}
      if (failed) break;
    }
    runFlow();
    createCheckpoint('运行后检查点');
    void saveProject();
    if (!cancel.current && order.every((node) => completed.has(node.id))) {
      try { localStorage.removeItem(runStateKey); } catch {}
      setResumeAvailable(false);
    } else setResumeAvailable(true);
    setRunning(false);
  };

  return (
    <div className="dock-runs">
      <div className="dock-run-toolbar"><div><strong>连续执行</strong><span className="dock-file-meta">按连线拓扑顺序运行；失败或停止后可继续未完成节点</span></div><div><button onClick={() => { cancel.current = true; }} disabled={!running}>停止</button>
      {/* #7：「全部停止」出口 —— 并发下必须能一次停干净所有在跑的请求（含被覆盖的那条控制权） */}
      <button className="dock-danger" onClick={stopEverything} disabled={!sending}>全部停止 Agent</button>
      <button className="dock-primary" onClick={() => void start()} disabled={running || !nodes.length}>{running ? '执行中…' : resumeAvailable ? '继续运行' : '运行工作流'}</button></div></div>
      {!nodes.length && <div className="dock-empty">画布为空，先添加节点。</div>}
      {agentRuns.length > 0 && <div className="dock-agent-recovery">
        <strong>可续跑的 Agent 运行（中断 / 达到步数上限）</strong>
        {agentRuns.map((run) => <div className="dock-recovery-row" key={run.runId || 'unknown'}>
          <span>{run.runId} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : '未知时间'}</span>
          <button onClick={() => run.runId && void inspectResume(run.runId)} disabled={recoveryBusy}>查看恢复计划</button>
        </div>)}
        {resumePlan && view && <div className="dock-recovery-plan">
          <div className="dock-recovery-meta">
            恢复级别：<strong>{view.modeLabel}</strong>
            {' · ' + view.reason}
            {resumePlan.completedSteps?.length ? ' · 已完成 ' + resumePlan.completedSteps.length + ' 步' : ''}
            {view.skippedCount ? ' · 幂等跳过 ' + view.skippedCount + ' 步' : ''}
          </div>
          {view.warning ? <div className="dock-recovery-warning" role="alert">{view.warning}</div> : null}
          {/* #21：后端明确要求人工复核时，必须把**复核什么**摆出来，
              并给出两个出口（了解风险强制续跑 / 按当前状态重试）。 */}
          {view.requiresReview ? (
            <div className="dock-recovery-review" role="alertdialog" aria-label="续跑需要人工复核">
              <div>需要人工复核，系统不会自动重放下面这些步骤：</div>
              {view.unknownTools.length ? (
                <div>
                  结果不可知的工具：
                  <strong data-testid="dock-resume-unknown-tools">{view.unknownTools.join('、')}</strong>
                </div>
              ) : null}
              {view.pendingLabels.length ? <div>待办 {view.pendingLabels.length} 步：{view.pendingLabels.slice(0, 8).join('、')}</div> : null}
              <div className="dock-recovery-actions">
                <button className="dock-danger" onClick={forceResume} disabled={busy} title={view.forceResumePrompt}>了解风险，强制续跑</button>
                <button onClick={retryResume} disabled={busy} title={view.retryPrompt}>按当前状态重试</button>
              </div>
            </div>
          ) : null}
          <pre>{view.warning || view.reason || resumePlan.error || '无恢复计划'}</pre>
          {resumePlan.ok && resumePlan.mode === 'auto' && (
            <button className="dock-primary" onClick={autoResume} disabled={busy}>自动续跑（跳过已提交的写操作）</button>
          )}
          {resumePlan.ok && resumePlan.mode !== 'auto' && !view.requiresReview && (
            <button className="dock-primary" onClick={retryResume} disabled={busy}>按当前状态重试（人工确认）</button>
          )}
        </div>}
      </div>}
      {metrics && <div className="dock-metrics">
        <span>本任务 token {metrics.cost?.run?.totalTokens ?? 0}</span>
        <span>今日 token {metrics.cost?.today?.totalTokens ?? 0}</span>
        <span>今日成本 {metrics.cost?.today?.costKnown === false ? '未知（未配置单价）' : '$' + (metrics.cost?.today?.costUsd ?? 0).toFixed(4)}</span>
        <span>隔离 {metrics.sandbox?.backend || 'none'}{metrics.sandbox?.degraded?.length ? '（降级：' + metrics.sandbox.degraded.join('/') + '）' : ''}</span>
        {metrics.alerts?.length ? <span className="dock-metrics-alert">{metrics.alerts[metrics.alerts.length - 1].message}</span> : null}
      </div>}
      <div className="dock-run-list">{items.map((item) => <div className={`dock-run-item ${item.status}`} key={item.id}><span className="dock-run-dot" /><div className="dock-run-main"><div><strong>{item.label}</strong><span className="dock-run-type">{item.type}</span><span className="dock-run-status">{item.status}</span></div>{item.output && <pre>{item.output}</pre>}</div></div>)}</div>
      <RunReplayPanel />
    </div>
  );
}

function CheckpointsPanel() {
  const items = useCheckpointStore((s) => s.items);
  const create = useCheckpointStore((s) => s.create);
  const restore = useCheckpointStore((s) => s.restore);
  const remove = useCheckpointStore((s) => s.remove);
  return <div className="dock-checkpoints"><div className="dock-run-toolbar"><div><strong>可恢复检查点</strong><span className="dock-file-meta">自动保留最近 30 个，浏览器重启后仍可恢复</span></div><button className="dock-primary" onClick={() => create('手动检查点')}>立即创建</button></div>{items.length === 0 ? <div className="dock-empty">还没有检查点。运行工作流前后会自动创建。</div> : <div className="dock-checkpoint-list">{items.map((item) => <div className="dock-checkpoint" key={item.id}><div><strong>{item.label}</strong><span>{new Date(item.createdAt).toLocaleString()} · {item.doc.root.nodes.length} 节点</span></div><div><button onClick={() => { if (restore(item.id)) useUiStore.getState().setToast('已恢复检查点：' + item.label); }}>恢复</button><button className="dock-danger" onClick={() => remove(item.id)}>删除</button></div></div>)}</div>}</div>;
}

function ExtensionsPanel() {
  const root = useProjectStore((s) => s.root);
  const [items, setItems] = useState<ProjectExtensionDto[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!window.codenode?.listExtensions) return;
    setLoading(true);
    void window.codenode.listExtensions(root).then((res) => { if (alive) { setItems(res.extensions || []); setLoading(false); } });
    return () => { alive = false; };
  }, [root]);
  const groups = ['内置工具', 'MCP', '插件', 'Skills', 'Hooks', '项目扩展'];
  return <div className="dock-extensions"><div className="dock-run-toolbar"><div><strong>扩展与工具</strong><span className="dock-file-meta">工具按注册表统一管理；项目可通过 .codenode/extensions.json 声明扩展</span></div><span className="dock-extension-count">{loading ? '加载中…' : `${items.length} 个已发现`}</span></div><div className="dock-extension-cards">{groups.slice(1).map((group) => <div className="dock-extension-card" key={group}><span className="dock-extension-icon">{group[0]}</span><div><strong>{group}</strong><p>可通过项目扩展清单接入</p></div><span className="dock-extension-state">可用</span></div>)}</div><div className="dock-tool-list">{items.map((item) => <div className="dock-tool-row" key={`${item.source}-${item.name}`}><span className="dock-tool-state" /><div><strong>{item.name}</strong><span>{item.kind} · {item.source}</span><p>{item.description || '无描述'}</p></div></div>)}</div></div>;
}

export default function WorkbenchDock() {
  const open = useUiStore((s) => s.dockOpen);
  const tab = useUiStore((s) => s.dockTab);
  const close = useUiStore((s) => s.closeDock);
  const setTab = useUiStore((s) => s.setDockTab);
  if (!open) return null;
  return <section className="workbench-dock"><div className="dock-tabs">{TABS.map((item) => <button key={item.id} className={item.id === tab ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}<span className="dock-tab-spacer" /><button className="dock-close" title="关闭工作台" onClick={close}>×</button></div><div className="dock-content">{tab === 'editor' && <EditorPanel />}{tab === 'diff' && <DiffPanel />}{tab === 'terminal' && <TerminalPanel />}{tab === 'runs' && <RunsPanel />}{tab === 'checkpoints' && <CheckpointsPanel />}{tab === 'extensions' && <ExtensionsPanel />}</div></section>;
}
