import { memo, useState } from 'react';
import type { SessionMsg } from '../../types';
import FileChangesCard from './FileChangesCard';
import { useProjectStore } from '../../store/projectStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { useTextReveal } from '../../hooks/useTextReveal';

/** 对话正文与简洁文件变更；工具和推理记录保留在运行数据中。 */
export function MessageView({ msg, isLatest = true }: { msg: SessionMsg; isLatest?: boolean }) {
  const grounding = msg.grounding;
  const safeAbstention = grounding?.status === 'valid' && grounding.semantic?.status === 'abstained' && grounding.semantic.safeForDelivery === true;
  const semanticFailed = grounding?.semantic?.supported === false && !safeAbstention;
  const projectRoot = useProjectStore((state) => state.root);
  const sessionId = useSessionStore((state) => state.activeId);
  const enabled = useUiStore(state => state.preferences.typewriterEnabled);
  const speed = useUiStore(state => state.preferences.typewriterCharsPerSecond);
  const display = useTextReveal(msg.content, { enabled: enabled && isLatest && msg.role === 'assistant' && !msg.compaction,
    speed, revision: msg.contentRevision || 0, scope: sessionId || '', status: msg.status });
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
                {a.mime.startsWith('image/') ? <img src={a.dataUrl} alt={a.name || '图片'} /> : a.mime.startsWith('audio/') ? <audio controls src={a.dataUrl} /> : <span>{a.name || '资源附件'}</span>}
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
        CodeNode{display.revealing || msg.status === 'running' && msg.content ? ' · 输出中…' : msg.status === 'running' ? ' · 思考中…' : ''}
      </span>
      {/* #25(b)：关键状态不能只靠颜色/图标表达 —— 读屏与键盘用户需要文本层的
          「已停止 / 已截断 / 失败」，这也让「点停止后界面像没反应」当场可见。 */}
      {msg.status === 'stopped' ? <div className="cs-msg-state" role="status">已停止（本轮回答可能不完整）</div> : null}
      {msg.status === 'truncated' ? <div className="cs-msg-state cs-msg-state-warn" role="status">已截断（触到模型长度上限，回复「继续」可接着写）</div> : null}
      {msg.status === 'failed' ? <div className="cs-msg-state cs-msg-state-error" role="status">本轮失败（详见下方错误说明）</div> : null}
      <div className="cs-msg-text" data-revealing={display.revealing ? 'true' : 'false'}>{display.text || (msg.status === 'running' ? '…' : '')}{display.revealing && <span className="cs-typewriter-cursor" aria-hidden="true" />}</div>
      <FileChangesCard message={msg} />
      {msg.backendEvents?.map((event, i) => {
        const c = event.content;
        if (c?.type === 'image') return <img key={i} style={{ maxWidth: '100%' }} src={`data:${c.mimeType};base64,${c.data}`} alt="Agent 图片" />;
        if (c?.type === 'audio') return <audio key={i} controls src={`data:${c.mimeType};base64,${c.data}`} />;
        if (c?.type === 'resource') return <details key={i}><summary>{c.resource.uri}</summary><pre>{c.resource.text || '二进制资源'}</pre></details>;
        if (c?.type === 'resource_link') return <p key={i}>{/^https?:/.test(c.uri) ? <a href={c.uri} target="_blank" rel="noreferrer">{c.title || c.name}</a> : `${c.name} · ${c.uri}`}</p>;
        return <details key={i}><summary>{event.kind === 'backend_terminal' ? 'Agent 终端' : event.info?.sessionUpdate || 'Agent 事件'}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{event.output ?? c?.text ?? JSON.stringify(event.info, null, 2)}{event.truncated ? '\n（输出已截断）' : ''}</pre></details>;
      })}
      {msg.content && msg.status !== 'running' && !display.revealing ? (
        <div className="cs-msg-feedback" aria-label="回答反馈">
          <button type="button" className={feedback === 'accept' ? 'active' : ''} aria-pressed={feedback === 'accept'} onClick={() => void sendFeedback('accept')}>有帮助</button>
          <button type="button" className={feedback === 'reject' ? 'active' : ''} aria-pressed={feedback === 'reject'} onClick={() => void sendFeedback('reject')}>需改进</button>
        </div>
      ) : null}
      {grounding && (safeAbstention || semanticFailed || grounding.status === 'missing' || grounding.status === 'invalid') ? (
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
    </div>
  );
}

export const MessageViewMemo = memo(MessageView);
