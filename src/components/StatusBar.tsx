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
      {/* #25(b)：toast 是失败/降级/停止等关键状态的唯一出口，必须是 live region
          （role=status 隐含 aria-live=polite）；容器常驻 DOM，否则读屏读不到后插入的提示。 */}
      <span className="status-toast" role="status" aria-live="polite" aria-atomic="true">
        {toast || ''}
      </span>
      <span className="status-hint">
        中键拖动画布 · Shift+A 添加节点 · Del/X 删除 · Ctrl+Z/Y 撤销重做
      </span>
    </footer>
  );
}
