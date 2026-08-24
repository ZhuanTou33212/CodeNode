import { memo, useRef, useState } from 'react';
import { useSessionStore } from '../store/sessionStore';
import type { SessionMsg } from '../types';

function MessageView({ msg }: { msg: SessionMsg }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const tools = msg.tools || [];
  const grounding = msg.grounding;

  if (msg.role === 'user') {
    return (
      <div className="cs-msg cs-msg-user">
        <span className="cs-msg-label">你</span>
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

const MessageViewMemo = memo(MessageView);

function SessionTree({ onPick }: { onPick: () => void }) {
  const sessions = useSessionStore((s) => s.sessions);
  const order = useSessionStore((s) => s.order);
  const activeId = useSessionStore((s) => s.activeId);
  const switchSession = useSessionStore((s) => s.switchSession);

  const list = order.map((id) => sessions[id]).filter(Boolean);

  const handleNew = () => {
    useSessionStore.getState().newCanvas();
    onPick();
  };

  return (
    <div className="cs-tree">
      <div className="cs-tree-title">
        会话画布（点击切换）
        <button className="cs-tree-new" onClick={handleNew} title="新建空白画布">
          ＋ 新画布
        </button>
      </div>
      {list.length === 0 && <div className="cs-tree-empty">暂无会话</div>}
      {[...list].reverse().map((sess) => {
        const isActive = sess.id === activeId;
        return (
          <div
            key={sess.id}
            className={`cs-tree-item ${isActive ? 'is-active' : ''}`}
            onClick={() => {
              switchSession(sess.id);
              onPick();
            }}
          >
            <div className="cs-tree-item-head">
              <span className="cs-tree-label">{sess.label}</span>
              <span className={`cs-tree-status ${sess.status === 'active' ? 'st-active' : 'st-done'}`}>
                {sess.status === 'active' ? '进行中' : '完成'}
              </span>
              <span className="cs-tree-count">{sess.nodeCount} 节点</span>
            </div>
            {sess.prompt ? (
              <div className="cs-tree-prompt">
                <span className="cs-tree-prompt-label">Prompt</span>
                <span className="cs-tree-prompt-text">{sess.prompt.length > 90 ? sess.prompt.slice(0, 90) + '…' : sess.prompt}</span>
              </div>
            ) : null}
            {sess.summary ? (
              <div className="cs-tree-preview">{sess.summary.length > 60 ? sess.summary.slice(0, 60) + '…' : sess.summary}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const SessionTreeMemo = memo(SessionTree);

export default function ChatSidebar() {
  const active = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const sessionCount = useSessionStore((s) => s.order.length);
  const streaming = useSessionStore((s) => s.streaming);
  const messages = useSessionStore((s) => s.messages);

  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const treeOpen = hover || pinned;

  const openTree = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHover(true);
  };

  const scheduleClose = () => {
    if (pinned) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setHover(false);
      closeTimer.current = null;
    }, 350);
  };

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const handlePick = () => {
    setPinned(false);
    setHover(false);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  return (
    <div
      className="cs-sidebar"
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      <div
        className="cs-badge"
        onMouseEnter={openTree}
        onClick={() => {
          setPinned((v) => !v);
          openTree();
        }}
        title={pinned ? '已固定会话列表，再次点击取消固定' : '点击固定会话列表'}
      >
        <span className={`cs-dot ${streaming ? 'cs-dot-running' : ''}`} />
        <span className="cs-badge-text">Agent{active ? ' · ' + active.label : ''}</span>
        {sessionCount > 0 && (
          <span className="cs-badge-count" title={`共 ${sessionCount} 个会话画布`}>
            {sessionCount}
          </span>
        )}
        <span className="cs-badge-chevron">{treeOpen ? '▾' : '▸'}</span>
      </div>

      <div className={`cs-panel ${treeOpen ? 'is-tree' : ''}`}>
        {treeOpen ? (
          <SessionTreeMemo onPick={handlePick} />
        ) : (
          <div className="cs-chat">
            <div className="cs-chat-head">
              <span className="cs-chat-name">{active ? active.label : '会话'}</span>
              <span className={`chat-win-status ${streaming ? 'st-running' : 'st-done'}`}>
                {streaming ? '思考中…' : active && active.status === 'active' ? '进行中' : ''}
              </span>
            </div>
            <div className="cs-chat-body">
              {messages.length === 0 && <div className="cs-chat-empty">（暂无对话）</div>}
              {messages.map((m, i) => (
                <MessageViewMemo key={i} msg={m} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
