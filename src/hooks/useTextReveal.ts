import { useLayoutEffect, useRef, useState } from 'react';
import { TextReveal } from '../lib/textReveal';
import outputUi from '../../config/ui.output.json';
export function useTextReveal(target: string, options: { enabled: boolean; speed: number; revision: number; scope: string; status?: string }) {
  const buffer = useRef<TextReveal | null>(null);
  if (!buffer.current) buffer.current = new TextReveal(target, options.revision);
  const scope = useRef(options.scope);
  const [visible, setVisible] = useState(target);
  const [reduced, setReduced] = useState(false);
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    let cancelled = false;
    let frame: number | null = null;
    const current = buffer.current!;
    if (scope.current !== options.scope) {
      buffer.current = new TextReveal(target, options.revision); scope.current = options.scope;
      setVisible(target); return;
    }
    current.update(target, options.revision);
    const interrupted = ['stopped', 'failed', 'truncated'].includes(options.status || '');
    if (!options.enabled || reduced || interrupted) { setVisible(current.flush()); return; }
    setVisible(current.text);
    const tick = (now: number) => {
      if (cancelled) return;
      setVisible(current.advance(now, options.speed, outputUi.maxCatchupMs));
      if (current.pending) frame = requestAnimationFrame(tick);
      else if (options.status === 'done' && current.text !== target) setVisible(current.flush());
    };
    if (current.pending) frame = requestAnimationFrame(tick);
    else if (options.status === 'done' && current.text !== target) setVisible(current.flush());
    return () => { cancelled = true; if (frame !== null) cancelAnimationFrame(frame); };
  }, [target, options.revision, options.scope, options.enabled, options.speed, options.status, reduced]);
  return { text: visible, revealing: visible !== target && options.enabled && !reduced && !['stopped', 'failed', 'truncated'].includes(options.status || '') };
}
