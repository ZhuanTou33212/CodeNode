import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
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

function WorkflowNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;
  const status = d.status || 'pending';
  const accent = d.accent || '#3b82f6';
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const flowOut = useGraphStore((s) => s.flow[id]?.output.length ?? 0);
  const flowIn = useGraphStore((s) => s.flow[id]?.input.length ?? 0);
  const nodeType = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.type);
  const promptable = nodeType === 'task' || nodeType === 'stage' || nodeType === 'tool';

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
      {promptable && (
        <textarea
          className="wf-prompt nodrag"
          rows={2}
          placeholder="任务 prompt…"
          value={d.prompt || ''}
          onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
        />
      )}
      <div className="wf-node-footer">
        <span className="wf-status-text" style={{ color: STATUS_COLOR[status] }}>
          {STATUS_TEXT[status] || status}
        </span>
        {flowOut > 0 && <span className="wf-flow-badge" title={`输入 ${flowIn} 项 · 输出 ${flowOut} 项`}>↦{flowOut}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export default memo(WorkflowNode);
