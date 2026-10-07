import { memo, useState } from 'react';
import type { SessionMsg } from '../../types';
import TaskTrace from './TaskTrace';
import CodeVerificationCard from './CodeVerificationCard';
import { useProjectStore } from '../../store/projectStore';
import { useSessionStore } from '../../store/sessionStore';

/** 单条会话消息（用户 / Agent），含推理与工具调用折叠区。原 ChatSidebar 内联实现，现供侧栏 Agent 标签复用。 */
export function MessageView({ msg }: { msg: SessionMsg }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const tools = msg.tools || [];
  const grounding = msg.grounding;
  const safeAbstention = grounding?.status === 'valid' && grounding.semantic?.status === 'abstained' && grounding.semantic.safeForDelivery === true;
  const semanticFailed = grounding?.semantic?.supported === false && !safeAbstention;
  const projectRoot = useProjectStore((state) => state.root);
  const sessionId = useSessionStore((state) => state.activeId);
  const [feedback, setFeedback] = useState<'accept' | 'reject' | null>(null);
  const sendFeedback = async (verdict: 'accept' | 'reject') => {
    if (!projectRoot || !msg.content || !window.codenode?.agentFeedback) return;
    const result = await window.codenode.agentFeedback(projectRoot, {
      verdict, content: msg.content, input: msg.feedbackInput || '', role: msg.role, sessionId: sessionId || undefined, tools: msg.tools || [],
    });
    if (result.ok) setFeedback(verdict);
  };

  // 上下文压缩卡（照 Codex CLI）：不是对话轮次，而是「更早的对话已被这份交接摘要取代」的标记。
  // 正文（content）是发给模型的信封原文；给人看的是折叠区里的摘要。
  if (msg.compaction) {
    const meta = msg.compactionMeta || {};
    return (
      <div className="cs-msg cs-msg-compaction" title="更早的对话已被一份交接摘要取代（同 Codex 的上下文压缩）；后续请求只发送摘要与本条之后的新消息">
        <span className="cs-msg-label">上下文已压缩</span>
        <div className="cs-msg-compaction-hint">
          更早的对话已换成一份交接摘要
          {meta.windowNumber ? ` · 第 ${meta.windowNumber} 次` : ''}
          {typeof meta.tokensBefore === 'number' ? ` · ${meta.tokensBefore} → ${meta.tokensAfter ?? 0} tokens` : ''}
          {meta.keptUserTurns ? ` · 保留 ${meta.keptUserTurns} 轮你的指令` : ''}
        </div>
        <details className="cs-msg-compaction-detail">
          <summary>查看交接摘要</summary>
          <div className="cs-msg-text">{meta.summary || msg.content}</div>
        </details>
      </div>
    );
  }

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
      {/* #25(b)：关键状态不能只靠颜色/图标表达 —— 读屏与键盘用户需要文本层的
          「已停止 / 已截断 / 失败」，这也让「点停止后界面像没反应」当场可见。 */}
      {msg.status === 'stopped' ? <div className="cs-msg-state" role="status">已停止（本轮回答可能不完整）</div> : null}
      {msg.status === 'truncated' ? <div className="cs-msg-state cs-msg-state-warn" role="status">已截断（触到模型长度上限，回复「继续」可接着写）</div> : null}
      {msg.status === 'failed' ? <div className="cs-msg-state cs-msg-state-error" role="status">本轮失败（详见下方错误说明）</div> : null}
      <div className="cs-msg-text">{msg.content || (msg.status === 'running' ? '…' : '')}</div>
      {msg.codeVerification && <CodeVerificationCard report={msg.codeVerification}/>}
      {msg.content && msg.status !== 'running' ? (
        <div className="cs-msg-feedback" aria-label="回答反馈">
          <button type="button" className={feedback === 'accept' ? 'active' : ''} aria-pressed={feedback === 'accept'} onClick={() => void sendFeedback('accept')}>有帮助</button>
          <button type="button" className={feedback === 'reject' ? 'active' : ''} aria-pressed={feedback === 'reject'} onClick={() => void sendFeedback('reject')}>需改进</button>
        </div>
      ) : null}
      {grounding && (grounding.status !== 'not_required' || semanticFailed) ? (
        <div
          className={`rag-grounding rag-grounding-${safeAbstention ? 'missing' : semanticFailed ? 'invalid' : grounding.status}`}
          title={grounding.invalid.length ? `无效引用：${grounding.invalid.join(', ')}` : safeAbstention ? '答复限定于已检查的证据范围，未证明项目存在或不存在所问机制' : semanticFailed ? '事实支持性未通过；证据不足或校验失败不等同于已证明结论错误' : '仅核对引用位置是否在本轮读过的来源内，未验证结论是否得到支持'}
        >
          {safeAbstention ? '△ 证据不足，已限定范围拒答' : semanticFailed ? '! 事实支持性未通过' : grounding.status === 'valid'
            ? grounding.used.length
              ? `✓ 引用位置可追溯（${grounding.used.length} 处）`
              : '✓ 本轮无需文件引用'
            : grounding.status === 'missing'
              ? '△ 回答缺少来源引用'
              : `! 发现 ${grounding.invalid.length} 个无效引用`}
        </div>
      ) : null}
      {tools.length ? <TaskTrace tools={tools} status={msg.status} /> : null}
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
