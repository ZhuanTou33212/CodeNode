import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentChatData, UserChatData } from '../types';

function AgentChatNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as AgentChatData;
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const reasoning = d.reasoning;
  const tools = d.tools || [];

  return (
    <div className={`chat-window chat-agent ${selected ? 'is-selected' : ''}`} style={{ width: d.width || 360 }}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="chat-win-header">
        <span className="chat-win-name">{d.name || 'CodeNode'}</span>
        <span className={`chat-win-status st-${d.status || 'pending'}`}>
          {d.status === 'running' ? '思考中…' : d.status || ''}
        </span>
      </div>
      <div className="chat-win-body">
        <div className="chat-output">{d.content || (d.status === 'running' ? '…' : '')}</div>
        {reasoning ? (
          <div className="chat-section">
            <button className="chat-section-toggle" onClick={() => setShowReasoning((v) => !v)}>
              推理 {showReasoning ? '▾' : '▸'}
            </button>
            {showReasoning && <div className="chat-section-body chat-reasoning">{reasoning}</div>}
          </div>
        ) : null}
        {tools.length ? (
          <div className="chat-section">
            <button className="chat-section-toggle" onClick={() => setShowTools((v) => !v)}>
              工具调用（{tools.length}）{showTools ? '▾' : '▸'}
            </button>
            {showTools && (
              <div className="chat-section-body">
                {tools.map((t, i) => (
                  <div key={i} className="chat-tool">
                    <span className={`ct-name ${t.ok === false ? 'ct-fail' : t.ok === true ? 'ct-ok' : ''}`}>{t.name}</span>
                    {t.args ? <span className="ct-args">{typeof t.args === 'string' ? t.args : JSON.stringify(t.args)}</span> : null}
                    {t.result != null && (
                      <pre className="ct-result">{t.result.length > 500 ? t.result.slice(0, 500) + '…' : t.result}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

function UserChatNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as UserChatData;
  return (
    <div className={`chat-window chat-user ${selected ? 'is-selected' : ''}`} style={{ width: d.width || 380, height: d.height || 120 }}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="chat-win-header">
        <span className="chat-win-name">用户</span>
      </div>
      <div className="chat-win-body">
        <div className="chat-output">{d.content || '（旧版对话节点）'}</div>
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export const AgentChatNodeMemo = memo(AgentChatNode);
export const UserChatNodeMemo = memo(UserChatNode);
