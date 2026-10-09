import {WorkbenchViewSwitcher} from './GoalOverview';
import { useSessionStore } from '../store/sessionStore';
import { useReactFlow } from '@xyflow/react';
import { useEffect, useLayoutEffect, type CSSProperties } from 'react';
import { useProjectSaveStore } from '../store/projectSaveStore';
import { workflowReadiness } from '../lib/workflowRunState';
import { CANVAS_ACTIONS } from '../lib/uiPreferences';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { saveProject } from '../lib/projectActions';
import { NODE_TEMPLATES } from '../nodes';
import type { VectorData } from '../types';

function positionToolbarMenus() {
  document.querySelectorAll<HTMLDetailsElement>('.toolbar-dropdown[open]').forEach(dropdown=>{
    const menu=dropdown.querySelector<HTMLElement>('.toolbar-menu');if(!menu)return;
    menu.style.left='0px';const bounds=menu.getBoundingClientRect();menu.style.left=`${Math.min(0,window.innerWidth-bounds.right-12)}px`;
  });
}
export default function Toolbar() {
  useLayoutEffect(()=>positionToolbarMenus());
  useEffect(()=>{window.addEventListener('resize',positionToolbarMenus);return()=>window.removeEventListener('resize',positionToolbarMenus)},[]);
  useEffect(() => {
    const closeMenus = (event: Event) => {
      document.querySelectorAll<HTMLDetailsElement>('.toolbar-dropdown[open]').forEach((menu) => {
        if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.contains(event.target as Node)) {
          menu.open = false;
          if (event instanceof KeyboardEvent) menu.querySelector('summary')?.focus();
        }
      });
    };
    document.addEventListener('pointerdown', closeMenus);
    document.addEventListener('keydown', closeMenus);
    return () => { document.removeEventListener('pointerdown', closeMenus); document.removeEventListener('keydown', closeMenus); };
  }, []);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const canUndo = useGraphStore((s) => s.past.length > 0);
  const canRedo = useGraphStore((s) => s.future.length > 0);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const selectedId = useGraphStore((s) => s.selectedId);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const layoutNodes = useGraphStore((s) => s.layoutNodes);
  const arrangeNodes = useGraphStore((s) => s.arrangeNodes);
  const runFlow = useGraphStore((s) => s.runFlow);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const conversationOpen=useUiStore(s=>s.conversationOpen);
  const toggleConversation=useUiStore(s=>s.toggleConversation);
  const saveState=useProjectSaveStore();
  const autoSave=useUiStore(s=>s.preferences.autoSaveEnabled);
  const nodes=useGraphStore(s=>s.nodes),edges=useGraphStore(s=>s.edges);
  const workflow=workflowReadiness(nodes,edges);
  const disabled=(action:typeof CANVAS_ACTIONS[number])=>action.requires==='workflow'?!workflow.ready:action.requires==='selection'?!selectedId:action.requires==='nodes'?!nodeCount:false;
  const preferences = useUiStore(s => s.preferences);
  const setToast = useUiStore((s) => s.setToast);
  const openDock = useUiStore((s) => s.openDock);
  const { fitView, getViewport, setViewport: rfSetViewport, screenToFlowPosition } = useReactFlow();

  return (
    <header className="toolbar">
      <span className={'toolbar-save-state state-'+saveState.status} role="status" title={saveState.error || (autoSave?'项目自动保存已开启；Ctrl+S 可手动保存':'自动保存已关闭；Ctrl+S 可手动保存')}>{saveState.status==='saving'?'保存中…':saveState.status==='error'?'保存失败':saveState.status==='dirty'?'未保存':saveState.status==='idle'?'未保存项目':'已保存'}</span>

      <div className="toolbar-group">
        <button title="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          ↶
        </button>
        <button title="重做 (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
          ↷
        </button>
      </div>

<details className="toolbar-group toolbar-dropdown" onToggle={(event) => {
        const dropdown = event.currentTarget;
        const menu = dropdown.querySelector<HTMLElement>('.toolbar-menu');
        if (!dropdown.open || !menu) return;
        menu.style.left = '0px';
        const bounds = menu.getBoundingClientRect();
        menu.style.left = `${Math.min(0, window.innerWidth - bounds.right - 12)}px`;
      }}>
        <summary>画布操作 <span className="toolbar-chevron" aria-hidden="true">⌄</span></summary>
        <div className="toolbar-menu" style={{'--canvas-menu-width': preferences.menuWidth + 'px', '--canvas-menu-row-height': preferences.menuRowHeight + 'px'} as CSSProperties} aria-label="画布操作" onClick={(event) => {
          const button = (event.target as HTMLElement).closest('button');
          if (button && !button.disabled) {
            const menu = event.currentTarget.parentElement as HTMLDetailsElement;
            menu.open = false;
            menu.querySelector('summary')?.focus();
          }
        }}>
          <div className="toolbar-menu-section"><button onClick={()=>void saveProject()}><span>保存项目</span>{preferences.showShortcuts&&<kbd>Ctrl+S</kbd>}</button></div>
{[...new Set(CANVAS_ACTIONS.map(action => action.group))].map(group => {
            const actions = CANVAS_ACTIONS.filter(action => action.group === group && preferences.visibleActions.includes(action.id))
              .filter(action => !preferences.hideDisabledActions || !disabled(action));
            if (!actions.length) return null;
            const handlers: Record<string, () => void> = {
              workflow:()=>openDock('runs'),
              duplicate: () => { if (selectedId) duplicateNode(selectedId); },
              properties: () => {
                const ui = useUiStore.getState();
                if (ui.sideTab === 'node' && ui.sideOpen) ui.setSideOpen(false);
                else ui.setSideTab('node');
              },
              delete: () => { if (selectedId) deleteNodes([selectedId]); },
              layout: () => { layoutNodes(); setToast('已横向整理：全部节点排在同一行'); },
              arrange: () => { arrangeNodes(); setToast('已自动整理：按依赖分层、分支并列'); },
              fit: () => { fitView({padding:0.2}); },
              flow: () => { runFlow(); setToast('数据流已计算'); },
              terminal: () => openDock('terminal'), checkpoints: () => openDock('checkpoints'),
            };
            return <div className="toolbar-menu-section" role="group" aria-label={group} key={group}>
              {preferences.showGroupLabels && <div className="toolbar-menu-label">{group}</div>}
              {actions.map(action => <button key={action.id} data-action={action.id} className={action.danger ? 'toolbar-menu-danger' : undefined} disabled={disabled(action)} title={action.id==='workflow'?workflow.reason||'查看执行范围，再开始工作流':undefined} onClick={handlers[action.id]}>
                <span>{action.label}</span>{preferences.showShortcuts && action.shortcut && <kbd>{action.shortcut}</kbd>}
              </button>)}
            </div>;
          })}
        </div>
      </details>

      <WorkbenchViewSwitcher/>
      <div className="toolbar-group toolbar-spacer" style={{ marginLeft: 'auto' }}>
        <button
          className="toolbar-vector"
          title="在当前画布中央放置一个画布节点：预设配件 + 自由绘制（设计/逻辑模式）"
          onClick={() => {
            if (!useSessionStore.getState().current()) useSessionStore.getState().newCanvas();
            const template = NODE_TEMPLATES.vector;
            const vd = template.data as VectorData;
            const w = vd.width ?? 1040;
            const h = vd.height ?? 640;
            const id = `vector-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

            // 视口中心（flow 坐标）放节点，尺寸按当前 zoom 折算，
            // 使节点完整落在可视区内 —— 不依赖 fitView 的时序。
            const host = document.querySelector('.canvas-wrap');
            const rect = host
              ? host.getBoundingClientRect()
              : ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } as DOMRect);
            const center = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            const vp = getViewport();
            const zoom = vp.zoom > 0 ? vp.zoom : 1;
            const flowW = w / zoom;
            const flowH = h / zoom;

            useGraphStore.getState().addNode({
              id,
              type: 'vector',
              position: { x: Math.round(center.x - flowW / 2), y: Math.round(center.y - flowH / 2) },
              data: { ...template.data },
            });
            useGraphStore.getState().setSelectedIds([id]);
            setToast('已添加画布节点');
            // 节点尺寸大（1040×640）且当前 zoom 可能偏大，收一档保证整块可见
            const targetZoom = Math.min(zoom, 0.55);
            const focus = () => {
              const c = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
              rfSetViewport({ x: rect.width / 2 - c.x * targetZoom, y: rect.height / 2 - c.y * targetZoom, zoom: targetZoom }, { duration: 240 });
            };
            window.setTimeout(focus, 90);
          }}
        >
          ✦ 画布节点
        </button>
        <button className="conversation-toggle" title={conversationOpen?'隐藏对话栏':'显示对话栏'} aria-label={conversationOpen?'隐藏对话栏':'显示对话栏'} aria-expanded={conversationOpen} aria-controls="conversation-panel" onClick={toggleConversation}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>
        </button>
      </div>
    </header>
  );
}
