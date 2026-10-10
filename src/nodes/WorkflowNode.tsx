import { memo, type CSSProperties } from 'react';
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

/** 节点类型 → 主色（与 NODE_TEMPLATES / Agent 建节点保持一致，按类型判定而非外观） */
const TYPE_ACCENT: Record<string, string> = {
  start: '#22c55e',
  end: '#ef4444',
  task: '#3b82f6',
  stage: '#8b5cf6',
  tool: '#f59e0b',
  file: '#f97316',
  scope: '#8b5cf6',
  object: '#06b6d4',
};

function WorkflowNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as WorkflowNodeData & { objectName?: string };
  const status = d.status || 'pending';
  const nodeType = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.type);
  const accent = d.accent || TYPE_ACCENT[nodeType || ''] || '#3b82f6';
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const flowOut = useGraphStore((s) => s.flow[id]?.output.length ?? 0);
  const flowIn = useGraphStore((s) => s.flow[id]?.input.length ?? 0);
  const promptable = nodeType === 'task' || nodeType === 'stage' || nodeType === 'tool';
  const isStart = nodeType === 'start';
  const isEnd = nodeType === 'end';
  const isObject = nodeType === 'object';
  const nodeStyle = { borderColor: `${accent}b8`, '--wf-accent': accent } as CSSProperties;

  return (
    <div className={`wf-node wf-node-${nodeType || 'default'} wf-status-${status} ${selected ? 'is-selected' : ''} ${isObject ? 'wf-object-node' : ''}`} style={nodeStyle}>
      {!isStart && <Handle type="target" position={Position.Left} className="wf-handle" />}
      <div className="wf-node-title">
        <span className="wf-status-dot" style={{ background: STATUS_COLOR[status] }} title={status} />
        <span className="wf-node-label">{d.label}</span>
        {d.memberBadge ? <span className="wf-member-badge" title="所属范围">{d.memberBadge}</span> : null}
      </div>
      <div className="wf-node-sub">{d.goal || d.subtitle || ''}</div>
      {d.trellis && <div className="wf-node-sub" title={d.trellis.taskPath}>Trellis · {d.trellis.role} · 快照 {d.trellis.snapshotId.slice(0, 8)}</div>}
      {isObject ? (
        <input
          className="wf-object-name nodrag"
          value={d.objectName || ''}
          placeholder="对象名称…"
          onChange={(e) => updateNodeData(id, { objectName: e.target.value })}
        />
      ) : promptable ? (
        <div className="wf-prompt-preview" title={d.prompt || '选中节点，在底部输入任务'}>{d.prompt || '选中后在底部输入任务'}</div>
      ) : null}
      <div className="wf-node-footer">
        <span className="wf-status-text" style={{ color: STATUS_COLOR[status] }}>
          {STATUS_TEXT[status] || status}
        </span>
        {flowOut > 0 && <span className="wf-flow-badge" title={`输入 ${flowIn} 项 · 输出 ${flowOut} 项`}>↦{flowOut}</span>}
      </div>
      {!isEnd && <Handle type="source" position={Position.Right} className="wf-handle" />}
    </div>
  );
}

export default memo(WorkflowNode);
