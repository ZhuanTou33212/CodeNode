import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GroupData, GroupIOData } from '../types';

function GroupNode({ data, selected }: NodeProps) {
  const d = data as unknown as GroupData;
  const inputs = d.sockets?.inputs || [];
  const outputs = d.sockets?.outputs || [];
  const accent = d.accent || '#06b6d4';

  return (
    <div className={`wf-group ${selected ? 'is-selected' : ''}`} style={{ borderColor: accent }}>
      <div className="wf-group-header">
        <span className="wf-group-icon" style={{ background: accent }}>G</span>
        <span className="wf-group-label">{d.label}</span>
      </div>
      <div className="wf-group-sub">
        {inputs.length} 入 / {outputs.length} 出 · 双击进入组
      </div>

      {inputs.map((s, i) => (
        <Handle
          key={s.id}
          type="target"
          position={Position.Left}
          id={s.id}
          className="wf-handle"
          style={{ top: 26 + i * 22 }}
          title={'组输入 ' + s.id}
        />
      ))}
      {outputs.map((s, i) => (
        <Handle
          key={s.id}
          type="source"
          position={Position.Right}
          id={s.id}
          className="wf-handle"
          style={{ top: 26 + i * 22 }}
          title={'组输出 ' + s.id}
        />
      ))}
    </div>
  );
}

function GroupInputNode({ data }: NodeProps) {
  const d = data as unknown as GroupIOData;
  return (
    <div className="wf-group-io wf-group-input">
      <div className="wf-group-io-label">{d.label}</div>
      {d.socketIds?.map((sid, i) => (
        <Handle
          key={sid}
          type="source"
          position={Position.Right}
          id={sid}
          className="wf-handle"
          style={{ top: 18 + i * 22 }}
        />
      ))}
    </div>
  );
}

function GroupOutputNode({ data }: NodeProps) {
  const d = data as unknown as GroupIOData;
  return (
    <div className="wf-group-io wf-group-output">
      <div className="wf-group-io-label">{d.label}</div>
      {d.socketIds?.map((sid, i) => (
        <Handle
          key={sid}
          type="target"
          position={Position.Left}
          id={sid}
          className="wf-handle"
          style={{ top: 18 + i * 22 }}
        />
      ))}
    </div>
  );
}

export const GroupNodeMemo = memo(GroupNode);
export const GroupInputNodeMemo = memo(GroupInputNode);
export const GroupOutputNodeMemo = memo(GroupOutputNode);
