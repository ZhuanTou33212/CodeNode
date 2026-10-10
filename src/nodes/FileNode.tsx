import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FileData } from '../types';

const STATUS_LABEL: Record<string, string> = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败', blocked: '阻塞' };

function FileNode({ data, selected }: NodeProps) {
  const d = data as unknown as FileData;
  const status = d.status || 'pending';
  const name = d.filePath ? d.filePath.split('/').pop() : d.label;
  const accent = d.accent || '#f97316';

  return (
    <div className={`wf-node wf-file wf-node-file wf-status-${status} ${selected ? 'is-selected' : ''}`} style={{ '--wf-accent': accent } as CSSProperties}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-title">
        <span className="wf-file-icon" aria-hidden="true">F</span>
        <span className="wf-node-title-copy">
          <span className="wf-node-type-caption">项目文件</span>
          <span className="wf-node-label" title={name}>{name}</span>
        </span>
      </div>
      <div className="wf-node-sub" title={d.filePath || ''}>
        {d.filePath || '未选择文件'}
      </div>
      <div className="wf-node-footer">
        <span className="wf-node-status"><span className="wf-status-dot" aria-hidden="true" /><span className="wf-status-text">{STATUS_LABEL[status] || status}</span></span>
        {d.memberBadge ? <span className="wf-member-badge" title="所属范围">{d.memberBadge}</span> : null}
        {d.content ? <span className="wf-file-loaded">已读取</span> : null}
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export default memo(FileNode);
