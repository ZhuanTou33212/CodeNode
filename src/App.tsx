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

function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export default function App() {
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const selectedId = useGraphStore((s) => s.selectedId);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const makeGroup = useGraphStore((s) => s.makeGroup);
  const ungroupGroup = useGraphStore((s) => s.ungroupGroup);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

      if (e.key === 'Home' || e.key.toLowerCase() === 'z') {
        e.preventDefault();
        fitView({ padding: 0.2 });
        return;
      }

      if (e.key.toLowerCase() === 'x' && !mod) {
        e.preventDefault();
        if (selectedId) deleteNodes([selectedId]);
        return;
      }

      if (mod && e.key.toLowerCase() === 'g' && e.shiftKey) {
        e.preventDefault();
        ungroupGroup();
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        makeGroup();
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
  }, [undo, redo, duplicateNode, selectedId, deleteNodes, fitView, makeGroup, ungroupGroup]);

  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        <ProjectManager />
        <Canvas />
        {inspectorOpen ? <Inspector /> : <InspectorBadge />}
        <AddMenu />
      </div>
      <StatusBar />
      <ToolDialog />
    </div>
  );
}
