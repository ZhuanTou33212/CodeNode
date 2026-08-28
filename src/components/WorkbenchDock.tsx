import { useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStore } from '../store/graphStore';
import { useProjectStore } from '../store/projectStore';
import { useCheckpointStore } from '../store/checkpointStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { saveProject } from '../lib/projectActions';
import type { Node } from '@xyflow/react';

type DockTab = 'editor' | 'diff' | 'terminal' | 'runs' | 'checkpoints' | 'extensions';
type RunItem = { id: string; label: string; type: string; status: 'pending' | 'running' | 'done' | 'failed' | 'blocked'; output?: string };

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
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<string[]>([]);
  const highlightRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (selected?.relPath && !tabs.includes(selected.relPath)) setTabs((list) => [...list, selected.relPath]);
  }, [selected?.relPath, tabs]);

  const save = async () => {
    setSaving(true);
    const ok = await saveSelected();
    setSaving(false);
    if (ok) useUiStore.getState().setToast(`已保存 ${selected?.relPath || '文件'}`);
  };

  if (!selected) return <div className="dock-empty">从左侧项目树点击文件，开始编辑。支持多文件标签、保存、撤销和 Diff 对比。</div>;
  const lines = draft.split(/\r?\n/).length;
  const language = selected.relPath.split('.').pop()?.toUpperCase() || 'TEXT';
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
      <div className="dock-code-wrap">
        <div className="dock-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
        <div className="dock-code-surface">
          <pre ref={highlightRef} className="dock-code-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightCode(draft) + '\n' }} />
          <textarea
            className="dock-code-editor"
            value={draft}
            spellCheck={false}
            onChange={(e) => updateDraft(e.target.value)}
            onScroll={(e) => { if (highlightRef.current) { highlightRef.current.scrollTop = e.currentTarget.scrollTop; highlightRef.current.scrollLeft = e.currentTarget.scrollLeft; } }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
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

  useEffect(() => {
    setItems(nodes.map((n) => ({ id: n.id, label: String((n.data as Record<string, unknown>)?.label || n.id), type: n.type || 'task', status: String((n.data as Record<string, unknown>)?.status || 'pending') as RunItem['status'] })));
    try { setResumeAvailable(!!localStorage.getItem(runStateKey)); } catch {}
  }, [nodes.length, runStateKey]);

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
      <div className="dock-run-toolbar"><div><strong>连续执行</strong><span className="dock-file-meta">按连线拓扑顺序运行；失败或停止后可继续未完成节点</span></div><div><button onClick={() => { cancel.current = true; }} disabled={!running}>停止</button><button className="dock-primary" onClick={() => void start()} disabled={running || !nodes.length}>{running ? '执行中…' : resumeAvailable ? '继续运行' : '运行工作流'}</button></div></div>
      {!nodes.length && <div className="dock-empty">画布为空，先添加节点。</div>}
      <div className="dock-run-list">{items.map((item) => <div className={`dock-run-item ${item.status}`} key={item.id}><span className="dock-run-dot" /><div className="dock-run-main"><div><strong>{item.label}</strong><span className="dock-run-type">{item.type}</span><span className="dock-run-status">{item.status}</span></div>{item.output && <pre>{item.output}</pre>}</div></div>)}</div>
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
