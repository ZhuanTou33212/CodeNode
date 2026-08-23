import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkflowNodeData } from '../types';

const STATUS_COLOR: Record<string, string> = {
  pending: '#64748b',
  running: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
  blocked: '#8b5cf6',
};

const STATUS_TEXT: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  blocked: '阻塞',
};

function WorkflowNode({ data, selected }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;
  const status = d.status || 'pending';
  const accent = d.accent || '#3b82f6';

  return (
    <div className={`wf-node ${selected ? 'is-selected' : ''}`} style={{ borderColor: accent }}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-title">
        <span className="wf-status-dot" style={{ background: STATUS_COLOR[status] }} title={status} />
        <span className="wf-node-label">{d.label}</span>
      </div>
      <div className="wf-node-sub">
        {d.goal || d.subtitle || ''}
      </div>
      <div className="wf-node-footer">
        <span className="wf-status-text" style={{ color: STATUS_COLOR[status] }}>
          {STATUS_TEXT[status] || status}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export default memo(WorkflowNode);
