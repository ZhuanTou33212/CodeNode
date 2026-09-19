import { useEffect, useRef, useState } from 'react';
import { useToolStore } from '../store/toolStore';

/**
 * Agent 审批 / 提问弹窗。
 *
 * #25(b)：修复前这个弹窗只有一层 `<div className="tool-dialog-mask">` —— 没有 `role="dialog"`、
 * 没有 `aria-modal`、没有焦点圈定、也没有 Escape 关闭：读屏软件根本不知道「来了一个需要
 * 应答的对话框」，键盘用户 Tab 会跑到背后的画布上，只能用鼠标点按钮。
 * 现在：`role="dialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby` + 打开即聚焦
 * + Tab 圈定在弹窗内 + Escape 关闭（关闭 = 与「取消」同义：明确应答，不是挂起）。
 *
 * 焦点管理的写法要能在 node 里断言（不放 DOM API 在渲染路径上）：处理函数单独导出。
 */
export default function ToolDialog() {
  const current = useToolStore((s) => s.current);
  const respond = useToolStore((s) => s.respond);
  const [text, setText] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const open = !!current;
  const dialogId = current ? `tool-dialog-${current.id}` : undefined;

  // 打开时：记住原焦点并移入弹窗；关闭时把焦点还回去（否则键盘/读屏用户会「掉」在页面某处）
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const node = dialogRef.current;
    if (node) {
      const first = firstFocusable(node);
      if (first) first.focus();
      else {
        node.focus();
      }
    }
    return () => {
      const back = previouslyFocused.current;
      if (back && typeof back.focus === 'function') back.focus();
    };
  }, [open, current?.id]);

  if (!current) return null;

  const reset = () => setText('');

  const cancel = () => {
    respond(current.id, closeResult(current));
    reset();
  };

  /** 弹窗内的键盘契约：Escape = 取消（明确应答）；Tab 圈定在弹窗内 */
  const onKeyDown = (e: { key: string; shiftKey?: boolean; preventDefault?: () => void }) => {
    const action = decideDialogKey({ key: e.key });
    if (action === 'close') {
      if (e.preventDefault) e.preventDefault();
      cancel();
      return;
    }
    if (action !== 'trap') return;
    const node = dialogRef.current;
    if (!node || typeof document === 'undefined') return;
    const items = focusables(node);
    const next = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey === true);
    if (next === null) return;
    if (e.preventDefault) e.preventDefault();
    items[next].focus();
  };

  const titleId = dialogId ? dialogId + '-title' : undefined;
  const descId = dialogId ? dialogId + '-what' : undefined;

  if (current.type === 'confirm') {
    return (
      <div className="tool-dialog-mask">
        <div
          className="tool-dialog"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <div className="tool-dialog-title" id={titleId}>Agent 请求确认</div>
          <div className="tool-dialog-what" id={descId}>{current.what}</div>
          {current.detail ? <div className="tool-dialog-detail">{current.detail}</div> : null}
          <div className={`tool-dialog-level lv-${(current.level || 'write').toLowerCase()}`}>
            级别：{current.level === 'HIGH' ? '高风险（需确认）' : current.level === 'WRITE' ? '写入/修改（默认放行）' : '低风险'}
          </div>
          <div className="tool-dialog-actions">
            <button className="tool-dialog-btn cancel" onClick={cancel}>
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
        <div
          className="tool-dialog"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <div className="tool-dialog-title" id={titleId}>Agent 向你提问</div>
          <div className="tool-dialog-what" id={descId}>{current.question}</div>
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
              aria-label="自由回答"
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
            <button className="tool-dialog-btn cancel" onClick={cancel}>
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

/**
 * 可聚焦元素集合（导出以便在 node 里用假对象断言，不需要真 DOM）。
 */
export function focusables(root: { querySelectorAll?: (sel: string) => ArrayLike<unknown> } | null): HTMLElement[] {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const list = root.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  return Array.from(list as ArrayLike<HTMLElement>);
}

export function firstFocusable(root: { querySelectorAll?: (sel: string) => ArrayLike<unknown> } | null): HTMLElement | null {
  return focusables(root)[0] || null;
}

/**
 * 弹窗键盘动作判定（#25(b) 的判据）：Escape → 关闭（= 明确应答「取消」，不是挂起），
 * Tab → 焦点圈定在弹窗内，其余 → 不管。
 */
export function decideDialogKey(event: { key?: string } | null | undefined): 'close' | 'trap' | 'none' {
  const key = String((event && event.key) || '');
  if (key === 'Escape') return 'close';
  if (key === 'Tab') return 'trap';
  return 'none';
}

/** Tab / Shift+Tab 的循环目标：没有可循环的对象时返回 null（不抢浏览器默认行为） */
export function nextFocusIndex(count: number, currentIndex: number, shift: boolean): number | null {
  if (count < 2) return null;
  if (shift) return currentIndex <= 0 ? count - 1 : null;
  return currentIndex === count - 1 ? 0 : null;
}

/** 关闭 / 取消时给主进程的应答：confirm → 明确拒绝；ask → 空回答 */
export function closeResult(current: { type: string } | null | undefined): { ok: boolean } | { answer: string } {
  if (current && current.type === 'confirm') return { ok: false };
  return { answer: '' };
}
