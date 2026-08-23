import { useUiStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';

export default function InspectorBadge() {
  const toggle = useUiStore((s) => s.toggleInspector);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const hasSelection = useGraphStore((s) => !!s.selectedId);

  return (
    <button className="inspector-badge" onClick={toggle} title="打开检查器">
      <span className="ib-label">检查器</span>
      <span className="ib-count">{nodeCount}</span>
      {hasSelection && <span className="ib-dot" />}
    </button>
  );
}
