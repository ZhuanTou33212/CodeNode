import { memo, useState } from 'react';
import type { SessionMsg } from '../../types';

/** 单条会话消息（用户 / Agent），含推理与工具调用折叠区。原 ChatSidebar 内联实现，现供侧栏 Agent 标签复用。 */
export function MessageView({ msg }: { msg: SessionMsg }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const tools = msg.tools || [];
  const grounding = msg.grounding;

  if (msg.role === 'user') {
    return (
      <div className="cs-msg cs-msg-user">
        <span className="cs-msg-label">你</span>
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="cs-msg-images">
            {msg.attachments.map((a, i) => (
              <a
                key={i}
                className="cs-msg-image"
                href={a.dataUrl}
                target="_blank"
                rel="noreferrer"
                title={`${a.name || '图片'}${a.bytes ? '（' + Math.round(a.bytes / 1024) + 'KB）' : ''} · 点击查看原图`}
              >
                <img src={a.dataUrl} alt={a.name || '图片'} />
              </a>
            ))}
          </div>
        )}
        <div className="cs-msg-text">{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="cs-msg cs-msg-agent">
      <span className={`cs-msg-label ${msg.status === 'running' ? 'cs-running' : ''}`}>
        CodeNode{msg.status === 'running' ? ' · 思考中…' : ''}
      </span>
      <div className="cs-msg-text">{msg.content || (msg.status === 'running' ? '…' : '')}</div>
      {grounding && grounding.status !== 'not_required' ? (
        <div
          className={`rag-grounding rag-grounding-${grounding.status}`}
          title={grounding.invalid.length ? `无效引用：${grounding.invalid.join(', ')}` : undefined}
        >
          {grounding.status === 'valid'
            ? `✓ 来源已校验（${grounding.used.length}/${grounding.allowed.length}）`
            : grounding.status === 'missing'
              ? '△ 回答缺少来源引用'
              : `! 发现 ${grounding.invalid.length} 个无效引用`}
        </div>
      ) : null}
      {msg.reasoning ? (
        <div className="chat-section">
          <button className="chat-section-toggle" onClick={() => setShowReasoning((v) => !v)}>
            推理 {showReasoning ? '▾' : '▸'}
          </button>
          {showReasoning && <div className="chat-section-body chat-reasoning">{msg.reasoning}</div>}
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
  );
}

export const MessageViewMemo = memo(MessageView);
