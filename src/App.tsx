import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import Toolbar from './components/Toolbar';
import ProjectManager from './components/ProjectManager';
import Canvas from './components/Canvas';
import Inspector from './components/Inspector';
import InspectorBadge from './components/InspectorBadge';
import AddMenu from './components/AddMenu';
import StatusBar from './components/StatusBar';
import { useGraphStore } from './store/graphStore';
import { useUiStore } from './store/uiStore';
import { newProject, openProject, saveProject, restoreLastProject } from './lib/projectActions';
import { installToolListener } from './lib/toolUi';
import ToolDialog from './components/ToolDialog';
import ModelManager from './components/ModelManager';
import WorkbenchDock from './components/WorkbenchDock';
import { getActiveVectorNode } from './vector/vectorStore';

function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/** 焦点在画布节点（矢量画布）内部时，工作台快捷键让位给节点自身。 */
function isVectorNodeFocus(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el?.closest?.('.vs-scope'));
}

export default function App() {
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const selectedId = useGraphStore((s) => s.selectedId);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const layoutNodes = useGraphStore((s) => s.layoutNodes);
  const arrangeNodes = useGraphStore((s) => s.arrangeNodes);
  const createScopeFromSelection = useGraphStore((s) => s.createScopeFromSelection);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const dockOpen = useUiStore((s) => s.dockOpen);
  const { fitView } = useReactFlow();

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => useUiStore.getState().setLastMouse(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, []);

  useEffect(() => {
    restoreLastProject();
    const uninstall = installToolListener();
    return uninstall;
  }, []);

  // 窄窗口优先保留画布与 Prompt，项目树可通过左上角按钮随时展开。
  useEffect(() => {
    let wasNarrow = window.innerWidth <= 780;
    if (wasNarrow && useUiStore.getState().leftOpen) useUiStore.getState().toggleLeft();
    const onResize = () => {
      const isNarrow = window.innerWidth <= 780;
      if (isNarrow && !wasNarrow && useUiStore.getState().leftOpen) {
        useUiStore.getState().toggleLeft();
      }
      wasNarrow = isNarrow;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 选中的是画布节点 / 焦点在矢量画布内时，快捷键交给画布节点处理
      const activeVector = getActiveVectorNode();
      if (activeVector && activeVector === selectedId) return;
      if (isVectorNodeFocus()) return;
      const mod = e.ctrlKey || e.metaKey;

      // 全局保存/打开/新建：即使在输入框中也生效
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject();
        return;
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void newProject();
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProject();
        return;
      }

      if (isTypingTarget()) return;

      if (e.code === 'KeyA' && e.shiftKey && !mod) {
        e.preventDefault();
        const m = useUiStore.getState().lastMouse;
        useUiStore.getState().openAddMenu(m.x, m.y);
        return;
      }

      if (e.key === 'Home' || (!mod && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        fitView({ padding: 0.2 });
        return;
      }

      if (e.key.toLowerCase() === 'x' && !mod) {
        e.preventDefault();
        if (selectedId) deleteNodes([selectedId]);
        return;
      }

      if (mod && e.key.toLowerCase() === 'j') {
        // Blender 风格：Ctrl+J 把选中的节点“加入”为一个新的范围节点
        e.preventDefault();
        createScopeFromSelection();
      } else if (mod && e.key.toLowerCase() === 'l') {
        // 自动排版属于画布操作，不入撤销历史（撤销只记录节点操作）
        e.preventDefault();
        layoutNodes();
      } else if (mod && e.key.toLowerCase() === 'a' && e.shiftKey) {
        e.preventDefault();
        arrangeNodes();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (selectedId) duplicateNode(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateNode, selectedId, deleteNodes, fitView, layoutNodes, arrangeNodes, createScopeFromSelection]);

  return (
    <div className="app">
      <Toolbar />
      <div className={`app-body${dockOpen ? ' has-dock' : ''}`}>
        <ProjectManager />
        <Canvas />
        {inspectorOpen ? <Inspector /> : <InspectorBadge />}
        <AddMenu />
        <WorkbenchDock />
      </div>
      <StatusBar />
      <ToolDialog />
      <ModelManager />
    </div>
  );
}
