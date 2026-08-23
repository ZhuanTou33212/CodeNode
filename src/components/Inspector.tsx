import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';

export default function Inspector() {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === s.selectedId));
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const toggleInspector = useUiStore((s) => s.toggleInspector);

  if (!node) {
    return (
      <aside className="inspector">
        <div className="inspector-header">
          <span className="panel-title">检查器</span>
          <button className="icon-btn" title="收起检查器" onClick={toggleInspector}>
            »
          </button>
        </div>
        <div className="inspector-empty">未选中节点</div>
      </aside>
    );
  }

  const d = node.data as Record<string, unknown>;
  const status = String(d.status || 'pending');

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span className="panel-title">检查器</span>
        <button className="icon-btn" title="收起检查器" onClick={toggleInspector}>
          »
        </button>
      </div>
      <div className="inspector-field">
        <label>ID</label>
        <input value={node.id} readOnly />
      </div>
      <div className="inspector-field">
        <label>类型</label>
        <input value={String(node.type)} readOnly />
      </div>
      <div className="inspector-field">
        <label>名称</label>
        <input
          value={String(d.label || '')}
          onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
        />
      </div>
      <div className="inspector-field">
        <label>状态</label>
        <select value={status} onChange={(e) => updateNodeData(node.id, { status: e.target.value })}>
          {['pending', 'running', 'done', 'failed', 'blocked'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="inspector-field">
        <label>目标 / 说明</label>
        <textarea
          value={String(d.goal || '')}
          rows={5}
          placeholder="该步骤的目标或说明…"
          onChange={(e) => updateNodeData(node.id, { goal: e.target.value })}
        />
      </div>
    </aside>
  );
}
