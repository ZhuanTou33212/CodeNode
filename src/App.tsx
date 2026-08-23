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
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const { fitView } = useReactFlow();

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => useUiStore.getState().setLastMouse(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, []);

  useEffect(() => {
    restoreLastProject();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      const mod = e.ctrlKey || e.metaKey;

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

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void newProject();
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProject();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (selectedId) duplicateNode(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateNode, selectedId, deleteNodes, fitView]);

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
    </div>
  );
}
