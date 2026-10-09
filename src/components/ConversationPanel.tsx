import { useEffect, useRef, type CSSProperties } from 'react';
import { useUiStore } from '../store/uiStore';
import AgentPanel from './side/AgentPanel';
import AgentSwitcher from './AgentSwitcher';
import {GoalBinding} from './GoalManager';

export default function ConversationPanel() {
  const open = useUiStore(state => state.conversationOpen);
  const width = useUiStore(state => state.conversationWidth);
  const setWidth = useUiStore(state => state.setConversationWidth);
  const panel = useRef<HTMLElement>(null);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const resize = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault(); cleanup.current();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try { if (pointerId) handle.setPointerCapture(pointerId); } catch {}
    const right = panel.current?.getBoundingClientRect().right || innerWidth;
    const move = (pointer: PointerEvent) => setWidth(right - pointer.clientX);
    const finish = () => { document.body.classList.remove('is-resizing-side'); try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch {} window.removeEventListener('blur',finish); window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',finish); window.removeEventListener('pointercancel',finish); };
    cleanup.current = finish; document.body.classList.add('is-resizing-side');
    window.addEventListener('blur',finish); window.addEventListener('pointermove',move); window.addEventListener('pointerup',finish); window.addEventListener('pointercancel',finish);
  };
  return <aside ref={panel} id="conversation-panel" className="conversation-workspace conversation-right" hidden={!open} aria-label="对话" style={{'--conversation-width': width+'px'} as CSSProperties}>
    <div className="conversation-resize" role="separator" aria-label="调整对话栏宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={640} aria-valuenow={width} tabIndex={0} onPointerDown={resize} onDoubleClick={()=>setWidth(400)} onKeyDown={event => { if(event.key==='ArrowLeft'||event.key==='ArrowRight') { event.preventDefault(); setWidth(width+(event.key==='ArrowLeft'?16:-16)); } }} />
    <header className="conversation-head"><strong>对话</strong><div className="conversation-head-actions"><AgentSwitcher /></div></header>
    <GoalBinding/>
    <AgentPanel />
  </aside>;
}
