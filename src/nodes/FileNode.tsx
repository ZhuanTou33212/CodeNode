import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FileData } from '../types';

function FileNode({ data, selected }: NodeProps) {
  const d = data as unknown as FileData;
  const status = d.status || 'pending';
  const name = d.filePath ? d.filePath.split('/').pop() : d.label;
  const accent = d.accent || '#f97316';

  return (
    <div className={`wf-node wf-file wf-node-file ${selected ? 'is-selected' : ''}`} style={{ borderColor: `${accent}b8`, '--wf-accent': accent } as CSSProperties}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-title">
        <span className="wf-file-icon">F</span>
        <span className="wf-node-label">{name}</span>
        {d.memberBadge ? <span className="wf-member-badge" title="所属范围">{d.memberBadge}</span> : null}
      </div>
      <div className="wf-node-sub" title={d.filePath || ''}>
        {d.filePath || '未选择文件'}
      </div>
      <div className="wf-node-footer">
        <span className="wf-status-text">{status}</span>
        {d.content ? <span className="wf-file-loaded">已读取</span> : null}
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export default memo(FileNode);
