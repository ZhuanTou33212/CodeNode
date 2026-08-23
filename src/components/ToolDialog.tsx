import { useState } from 'react';
import { useToolStore } from '../store/toolStore';

export default function ToolDialog() {
  const current = useToolStore((s) => s.current);
  const respond = useToolStore((s) => s.respond);
  const [text, setText] = useState('');

  if (!current) return null;

  const reset = () => setText('');

  if (current.type === 'confirm') {
    return (
      <div className="tool-dialog-mask">
        <div className="tool-dialog">
          <div className="tool-dialog-title">Agent 请求确认</div>
          <div className="tool-dialog-what">{current.what}</div>
          {current.detail ? <div className="tool-dialog-detail">{current.detail}</div> : null}
          <div className={`tool-dialog-level lv-${(current.level || 'write').toLowerCase()}`}>
            级别：{current.level === 'HIGH' ? '高风险（需确认）' : current.level === 'WRITE' ? '写入/修改（默认放行）' : '低风险'}
          </div>
          <div className="tool-dialog-actions">
            <button
              className="tool-dialog-btn cancel"
              onClick={() => {
                respond(current.id, { ok: false });
                reset();
              }}
            >
              取消
            </button>
            <button
              className="tool-dialog-btn allow"
              onClick={() => {
                respond(current.id, { ok: true });
                reset();
              }}
            >
              允许
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (current.type === 'ask') {
    return (
      <div className="tool-dialog-mask">
        <div className="tool-dialog">
          <div className="tool-dialog-title">Agent 向你提问</div>
          <div className="tool-dialog-what">{current.question}</div>
          <div className="tool-dialog-options">
            {(current.options || []).map((opt) => (
              <button
                key={opt}
                className="tool-dialog-opt"
                onClick={() => {
                  respond(current.id, { answer: opt });
                  reset();
                }}
              >
                {opt}
              </button>
            ))}
          </div>
          <div className="tool-dialog-free">
            <input
              className="tool-dialog-input"
              value={text}
              placeholder="或输入自由回答…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) {
                  respond(current.id, { answer: text.trim() });
                  reset();
                }
              }}
            />
          </div>
          <div className="tool-dialog-actions">
            <button
              className="tool-dialog-btn cancel"
              onClick={() => {
                respond(current.id, { answer: '' });
                reset();
              }}
            >
              取消
            </button>
            <button
              className="tool-dialog-btn allow"
              disabled={!text.trim()}
              onClick={() => {
                respond(current.id, { answer: text.trim() });
                reset();
              }}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
