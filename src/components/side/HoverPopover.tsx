import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 悬浮弹层（portal 到 document.body）。
 *
 * 侧栏用了 `container-type: inline-size`（供容器查询）并 `overflow: hidden`，
 * 这两者会裁剪 / 限制内部元素 —— 普通绝对定位或 fixed 弹层都会被切掉。
 * 因此弹层必须 portal 到 body 之外渲染，再按触发点坐标定位。
 */
export default function HoverPopover({
  content,
  children,
  className,
  anchorClassName,
  width = 228,
  height = 168,
  gap = 8,
}: {
  content: ReactNode;
  children: ReactNode;
  /** 追加到弹层根上的类名 */
  className?: string;
  /** 追加到触发点容器上的类名（用于在父级 flex 中定位，如 margin-left:auto） */
  anchorClassName?: string;
  width?: number;
  height?: number;
  /** 与触发点的间距 */
  gap?: number;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [open, setOpen] = useState(false);
  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    // 优先右对齐触发点（避免窄侧栏里向右溢出），再按视口收敛
    let left = r.right - width;
    if (left < margin) left = r.left;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    // 优先向下展开；下方放不下就翻到上方
    const below = r.bottom + gap;
    const top = below + height + margin > vh ? Math.max(margin, r.top - height - gap) : below;
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [gap, height, width]);

  const openIt = () => {
    place();
    setOpen(true);
  };
  const closeIt = () => setOpen(false);

  // 视口变化时重新定位，避免弹层飘走
  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => place();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, place]);

  return (
    <span
      ref={anchorRef}
      className={`hover-pop-anchor${anchorClassName ? ' ' + anchorClassName : ''}`}
      onMouseEnter={openIt}
      onMouseLeave={closeIt}
      onFocus={openIt}
      onBlur={closeIt}
    >
      {children}
      {open && pos
        ? createPortal(
            <div
              className={`hover-pop${className ? ' ' + className : ''}`}
              style={{ left: pos.left, top: pos.top, width, maxHeight: 'calc(100vh - 16px)' }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
