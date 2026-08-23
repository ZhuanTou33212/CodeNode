import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useUiStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import { NODE_TEMPLATES } from '../nodes';

export default function AddMenu() {
  const menu = useUiStore((s) => s.addMenu);
  const close = useUiStore((s) => s.closeAddMenu);
  const addNode = useGraphStore((s) => s.addNode);
  const screenToFlowPosition = useReactFlow().screenToFlowPosition;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (!menu) return null;

  const handlePick = (type: string, template: (typeof NODE_TEMPLATES)[string]) => {
    const position = screenToFlowPosition({ x: menu.x, y: menu.y });
    const id = `${type}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    addNode({ id, type, position, data: { ...template.data } });
    close();
  };

  return (
    <div className="add-menu" style={{ left: menu.x, top: menu.y }}>
      <div className="add-menu-title">添加节点</div>
      {Object.entries(NODE_TEMPLATES).map(([type, t]) => (
        <div
          key={type}
          className="add-menu-item"
          onClick={() => handlePick(type, t)}
          onMouseEnter={(e) => {
            const el = e.currentTarget;
            const rect = el.getBoundingClientRect();
            if (rect.right > window.innerWidth - 8) el.classList.add('flip');
            else el.classList.remove('flip');
          }}
        >
          <span className="library-item-dot" style={{ background: t.data.accent }} />
          <span className="add-menu-label">{t.label}</span>
          <span className="add-menu-sub">{t.subtitle}</span>
        </div>
      ))}
      <div className="add-menu-tip">Escape 关闭 · 选择后将在光标位置创建</div>
    </div>
  );
}
