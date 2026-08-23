import { useReactFlow } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';

export default function StatusBar() {
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const edgeCount = useGraphStore((s) => s.edges.length);
  const selectedId = useGraphStore((s) => s.selectedId);
  const toast = useUiStore((s) => s.toast);
  const viewport = useReactFlow().getViewport();

  return (
    <footer className="status-bar">
      <span>节点 {nodeCount}</span>
      <span>连线 {edgeCount}</span>
      <span>选中 {selectedId ? 1 : 0}</span>
      <span>缩放 {Math.round(viewport.zoom * 100)}%</span>
      {toast && <span className="status-toast">{toast}</span>}
      <span className="status-hint">
        中键拖动画布 · Shift+A 添加节点 · Del/X 删除 · Ctrl+Z/Y 撤销重做
      </span>
    </footer>
  );
}
