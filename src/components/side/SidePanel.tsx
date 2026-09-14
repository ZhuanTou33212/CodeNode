import { useCallback, useEffect, useRef } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useProjectStore } from '../../store/projectStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore, type SideTab } from '../../store/uiStore';
import AgentPanel from './AgentPanel';
import NodePanel from './NodePanel';
import ProjectPanel from './ProjectPanel';
import PreviewPanel from './PreviewPanel';

const TABS: { id: SideTab; label: string; title: string }[] = [
  { id: 'agent', label: 'Agent', title: 'Agent 对话与会话画布' },
  { id: 'node', label: '节点', title: '选中节点属性' },
  { id: 'project', label: '项目', title: '项目文件树' },
  { id: 'preview', label: '预览', title: '文件内容预览' },
];

/**
 * 左侧统一侧栏：Agent 对话 + 节点属性 + 项目文件树 + 文件预览，全部收进同一个 tab 面板。
 * 宽窗口里由 .side-panel 在 flex 布局中占位；窄窗口里由媒体查询改为左侧浮层。
 */
export default function SidePanel() {
  const tab = useUiStore((s) => s.sideTab);
  const width = useUiStore((s) => s.sideWidth);
  const setSideTab = useUiStore((s) => s.setSideTab);
  const setSideOpen = useUiStore((s) => s.setSideOpen);
  const setSideWidth = useUiStore((s) => s.setSideWidth);

  const panelRef = useRef<HTMLElement | null>(null);

  const selectedId = useGraphStore((s) => s.selectedId);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const filePath = useProjectStore((s) => s.selected?.relPath ?? null);
  const fileDirty = useProjectStore((s) => s.dirty);
  const hasTree = useProjectStore((s) => s.tree.length > 0);
  const messageCount = useSessionStore((s) => s.messages.length);
  const streaming = useSessionStore((s) => s.streaming);

  const openFileInPreview = useCallback(() => setSideTab('preview'), [setSideTab]);

  /** ⌘P / Ctrl+P：跳到项目标签并聚焦过滤框 */
  const focusFilter = useCallback(() => {
    setSideTab('project');
    window.setTimeout(() => panelRef.current?.querySelector<HTMLInputElement>('.pm-search input')?.focus(), 0);
  }, [setSideTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'p') return;
      e.preventDefault();
      focusFilter();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusFilter]);

  /** 拖拽右边缘调整宽度（面板贴左，向右拖变宽） */
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = panelRef.current;
    if (!el) return;
    const left = el.getBoundingClientRect().left;
    document.body.classList.add('is-resizing-side');
    const onMove = (ev: MouseEvent) => setSideWidth(ev.clientX - left);
    const onUp = () => {
      document.body.classList.remove('is-resizing-side');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const activeTab = TABS.find((t) => t.id === tab) || TABS[0];

  return (
    <aside ref={panelRef} className={`side-panel sp-tab-${tab}`} style={{ width }} aria-label="侧栏">
      <div className="pm-resize" onMouseDown={startResize} title="拖动调整侧栏宽度" />

      <header className="sp-head">
        <div className="sp-head-title">
          <span className="sp-head-name">{activeTab.label}</span>
          {tab === 'agent' && (
            <span className="sp-head-meta">{streaming ? '思考中…' : messageCount ? `${messageCount} 条消息` : '待输入'}</span>
          )}
          {tab === 'node' && <span className="sp-head-meta">{nodeCount} 节点</span>}
          {tab === 'project' && hasTree && <span className="sp-head-meta">文件树</span>}
          {tab === 'preview' && filePath && <span className="sp-head-meta">只读</span>}
        </div>
        <button className="icon-btn sp-close" title="收起侧栏 (Ctrl+B)" onClick={() => setSideOpen(false)}>
          »
        </button>
      </header>

      <div className="sp-tabs" role="tablist" aria-label="侧栏标签">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              className={`sp-tab ${active ? 'is-active' : ''}`}
              onClick={() => setSideTab(t.id)}
              title={t.title}
            >
              <span className="sp-tab-label">{t.label}</span>
              {t.id === 'agent' && (streaming || messageCount > 0) && (
                <span className={`sp-tab-dot ${streaming ? 'is-busy' : ''}`} />
              )}
              {t.id === 'node' && selectedId && <span className="sp-tab-dot" />}
              {t.id === 'preview' && filePath && <span className={`sp-tab-dot ${fileDirty ? 'is-warn' : ''}`} />}
            </button>
          );
        })}
      </div>

      <div className="sp-body">
        {tab === 'agent' && <AgentPanel />}
        {tab === 'node' && <NodePanel onOpenFile={openFileInPreview} />}
        {tab === 'project' && <ProjectPanel onOpen={openFileInPreview} />}
        {tab === 'preview' && <PreviewPanel onBack={() => setSideTab('project')} />}
      </div>
    </aside>
  );
}
