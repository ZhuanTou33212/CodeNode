import { memo, useEffect, useRef } from 'react';
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

/** prompt 自适应高度的 textarea：随内容自动撑高 */
function AutoPrompt({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, 46) + 'px';
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="wf-prompt nodrag"
      rows={2}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

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
        <AutoPrompt
          value={d.prompt || ''}
          onChange={(v) => updateNodeData(id, { prompt: v })}
          placeholder="任务 prompt…"
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
