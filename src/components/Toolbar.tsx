import { useSessionStore } from '../store/sessionStore';
import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { saveProject } from '../lib/projectActions';
import { NODE_TEMPLATES } from '../nodes';
import type { VectorData } from '../types';

export default function Toolbar() {
  useEffect(() => {
    const closeMenus = (event: Event) => {
      document.querySelectorAll<HTMLDetailsElement>('.toolbar-dropdown[open]').forEach((menu) => {
        if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.contains(event.target as Node)) menu.open = false;
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
  const sideOpen = useUiStore((s) => s.navigationOpen);
  const toggleSide = useUiStore((s) => s.toggleNavigation);
  const setToast = useUiStore((s) => s.setToast);
  const openDock = useUiStore((s) => s.openDock);
  const { fitView, getViewport, setViewport: rfSetViewport, screenToFlowPosition } = useReactFlow();

  return (
    <header className="toolbar">
      <button className="toolbar-save" title="保存项目 (Ctrl+S)" onClick={() => void saveProject()}>保存</button>

      <div className="toolbar-group">
        <button title="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          ↶
        </button>
        <button title="重做 (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
          ↷
        </button>
      </div>

      <div className="toolbar-group">
        <button
          className={`toolbar-side ${sideOpen ? 'is-on' : ''}`}
          title="显示 / 隐藏项目导航"
          aria-pressed={sideOpen}
          onClick={toggleSide}
        >
          侧栏
        </button>
      </div>

      <div className="toolbar-group toolbar-primary-actions">
        <button title="打开代码编辑器" onClick={() => openDock('editor')}>
          编辑
        </button>
        <button
          className="toolbar-run"
          title="按连线拓扑连续执行工作流"
          disabled={nodeCount === 0}
          onClick={() => openDock('runs')}
        >
          运行
        </button>
      </div>
      <details className="toolbar-group toolbar-dropdown"><summary>更多⌄</summary><div className="toolbar-menu" onClick={(event) => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.parentElement?.removeAttribute('open'); }}>
        <button className="toolbar-overflow-small" onClick={() => void saveProject()}>保存</button>
        <button className="toolbar-overflow-small" onClick={() => openDock('editor')}>编辑</button>
        <button className="toolbar-overflow-small" disabled={!nodeCount} onClick={() => openDock('runs')}>运行</button>
        <button
          title="复制节点 (Ctrl+D)"
          disabled={!selectedId}
          onClick={() => selectedId && duplicateNode(selectedId)}
        >
          复制
        </button>
        <button
          title="删除选中 (Del)"
          disabled={!selectedId}
          onClick={() => selectedId && deleteNodes([selectedId])}
        >
          删除
        </button>
        <button
          title="横向整理：全部节点排在同一行，分支并列 (Ctrl+L)"
          disabled={nodeCount === 0}
          onClick={() => {
            layoutNodes();
            setToast('已横向整理：全部节点排在同一行');
          }}
        >
          横排
        </button>
        <button
          title="自动整理（Blender Node Arrange 风格）：按依赖分层为列，分支并列 (Ctrl+Shift+A)"
          disabled={nodeCount === 0}
          onClick={() => {
            arrangeNodes();
            setToast('已自动整理：按依赖分层、分支并列');
          }}
        >
          自动整理
        </button>
        <button
          title="运行数据流：按连线拓扑计算各节点输入/输出"
          disabled={nodeCount === 0}
          onClick={() => {
            runFlow();
            setToast('数据流已计算');
          }}
        >
          数据流
        </button>
        <button title="打开检查点与恢复历史" onClick={() => openDock('checkpoints')}>
          恢复
        </button>
        <button title="聚焦全部 (Z)" onClick={() => fitView({ padding: 0.2 })}>
          聚焦
        </button>
      </div></details>

      <div className="toolbar-group toolbar-spacer" style={{ marginLeft: 'auto' }}>
        <button
          className="toolbar-vector"
          title="在当前画布中央放置一个画布节点：预设配件 + 自由绘制（设计/逻辑模式）"
          onClick={() => {
            if (!useSessionStore.getState().current()) useSessionStore.getState().newCanvas();
            useUiStore.getState().setSideTab('node');
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
      </div>
    </header>
  );
}
