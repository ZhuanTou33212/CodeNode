import { useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';

export default function PromptBar() {
  const [text, setText] = useState('');
  const sending = useChatStore((s) => s.sending);
  const streaming = useSessionStore((s) => s.streaming);
  const active = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const busy = sending || streaming;
  const taRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
    const res = await useChatStore.getState().send(prompt);
    if (!res.reply && !res.tools.length) {
      useUiStore.getState().setToast('Agent 未返回内容，请重试');
    }
  };

  return (
    <div className="prompt-bar">
      <div className="prompt-bar-inner">
        <span className="prompt-bar-tag">{active ? active.label : '画布'}</span>
        <textarea
          ref={taRef}
          className="prompt-bar-input"
          value={text}
          rows={1}
          placeholder="输入 prompt…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => {
            setText(e.target.value);
            const el = taRef.current;
            if (el) {
              el.style.height = 'auto';
              el.style.height = Math.min(120, el.scrollHeight) + 'px';
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="prompt-bar-btn" onClick={() => void send()} disabled={busy || !text.trim()}>
          {busy ? '思考中…' : '发送'}
        </button>
      </div>
    </div>
  );
}
