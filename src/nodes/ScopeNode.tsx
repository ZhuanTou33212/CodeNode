import { memo, type CSSProperties } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { computeChildren } from '../lib/flow';
import { useContainerAutoFit } from '../lib/useContainerAutoFit';
import type { ScopeData } from '../types';

function ScopeNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as ScopeData;
  const nodes = useGraphStore((s) => s.nodes);
  const scopeNode = useGraphStore((s) => s.nodes.find((n) => n.id === id));
  const hoverScopeId = useUiStore((s) => s.hoverScopeId);
  const toggleScopeCollapsed = useGraphStore((s) => s.toggleScopeCollapsed);
  const children = scopeNode ? computeChildren(scopeNode, nodes) : [];

  useContainerAutoFit(id, nodes, 220, 150, 20);

  const accent = d.accent || '#8b5cf6';
  const fill = d.fill || '#3b2f6b';
  const collapsed = !!d.collapsed;
  const scopeStyle = {
    width: d.width || 320,
    height: d.height || 220,
    borderColor: `${accent}b8`,
    '--wf-accent': accent,
    background: `${fill}${Math.round((d.opacity ?? 0.16) * 255)
      .toString(16)
      .padStart(2, '0')}`,
  } as CSSProperties;

  return (
    <div
      className={`wf-scope ${selected ? 'is-selected' : ''} ${hoverScopeId === id ? 'is-hover-target' : ''}`}
      style={scopeStyle}
    >
      <NodeResizer
        isVisible={true}
        minWidth={160}
        minHeight={120}
        color={accent}
        keepAspectRatio={false}
        onResizeStart={() => {
          const st = useGraphStore.getState();
          st.commit();
          st.setResizing([id]);
        }}
        onResize={(_, params) => {
          const st = useGraphStore.getState();
          const node = st.nodes.find((n) => n.id === id);
          if (!node) return;
          if (Math.abs(params.x - node.position.x) > 0.5 || Math.abs(params.y - node.position.y) > 0.5) {
            st.moveNode(id, { x: params.x, y: params.y }, { moveChildren: false });
          }
          st.updateNodeData(id, { width: Math.round(params.width), height: Math.round(params.height) });
        }}
        onResizeEnd={() => useGraphStore.getState().setResizing([])}
      />
      <div className="wf-scope-title">
        <button
          className="wf-scope-toggle nodrag"
          title={collapsed ? '展开成员' : '折叠成员'}
          onClick={() => toggleScopeCollapsed(id)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span>{d.label}</span>
      </div>
      <div className="wf-scope-sub">范围 · 成员 {children.length}{collapsed ? ' · 已折叠' : ''}</div>
    </div>
  );
}

export default memo(ScopeNode);
