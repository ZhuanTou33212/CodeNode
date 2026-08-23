import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { computeChildren } from '../lib/flow';
import { useContainerAutoFit } from '../lib/useContainerAutoFit';
import type { ScopeData } from '../types';

function ScopeNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as ScopeData;
  const nodes = useGraphStore((s) => s.nodes);
  const scopeNode = useGraphStore((s) => s.nodes.find((n) => n.id === id));
  const children = scopeNode ? computeChildren(scopeNode, nodes) : [];

  useContainerAutoFit(id, nodes, 220, 150, 20);

  const accent = d.accent || '#8b5cf6';
  const fill = d.fill || '#3b2f6b';

  return (
    <div
      className={`wf-scope ${selected ? 'is-selected' : ''}`}
      style={{
        width: d.width || 320,
        height: d.height || 220,
        borderColor: accent,
        background: `${fill}${Math.round((d.opacity ?? 0.16) * 255)
          .toString(16)
          .padStart(2, '0')}`,
      }}
    >
      <div className="wf-scope-title">{d.label}</div>
      <div className="wf-scope-sub">自适应包裹 {children.length} 个节点</div>
    </div>
  );
}

export default memo(ScopeNode);
