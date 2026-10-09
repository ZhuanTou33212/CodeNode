import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import backendConfig from '../../config/agent.backends.json';
import type { AgentBackendSettings } from '../types';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { useBackendSwitchStore } from '../store/backendSwitchStore';
import { useSending } from '../lib/useSending';

type Backend = AgentBackendSettings['backend'];
const shortLabel=(name:Backend)=>labels[name].replace(' ACP','').replace(' Agent','');
const labels = backendConfig.labels as Record<Backend, string>;
export default function AgentSwitcher() {
  const root = useProjectStore(s => s.root);
  const sessionId = useSessionStore(s => s.activeId);
  const hasHistory = useSessionStore(s => s.messages.some(m => m.role === 'user'));
  const streaming = useSessionStore(s => s.streaming);
  const sending = useSending();
  const switching = useBackendSwitchStore(s => s.switching);
  const theme = useUiStore(s => s.theme);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Backend>('builtin');
  const [target, setTarget] = useState<Backend>('builtin');
  const [profiles, setProfiles] = useState<Partial<Record<Backend, AgentBackendSettings>>>({});
  const [availability,setAvailability]=useState<Partial<Record<Backend,{installed:boolean;reason?:string}>>>({});
  const [error, setError] = useState('');
  const [position, setPosition] = useState({left:0,top:0});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const busy = streaming || sending || switching;
  useEffect(() => {
    let alive = true;
    setOpen(false); setLoading(true); setError('');
    const refresh = () => void window.codenode?.agentConfig(root, sessionId).then(result => {
      if (!alive) return;
      const current = result.backend?.sessionSettings || result.backend?.settings;
      setSelected(current?.backend || 'builtin'); setTarget(current?.backend || 'builtin');
      setAvailability(result.backend?.availability||{});
      setProfiles({...result.backend?.profiles,...(current?{[current.backend]:current}:{})});
    }).catch(() => { if(alive)setError('读取 Agent 配置失败，请在设置中检查连接。'); }).finally(() => {if(alive)setLoading(false);});
    refresh(); window.addEventListener('codenode-backend-settings',refresh);
    return () => {alive=false;window.removeEventListener('codenode-backend-settings',refresh);};
  }, [root,sessionId]);
  useEffect(() => {if(busy)setOpen(false);},[busy]);
  useLayoutEffect(() => {
    if(!open)return;
    const place=()=>{const r=trigger.current?.getBoundingClientRect();if(r)setPosition({left:Math.max(8,Math.min(r.right-218,innerWidth-226)),top:r.bottom+8});};
    place();window.addEventListener('resize',place);return()=>window.removeEventListener('resize',place);
  },[open]);
  useEffect(() => {
    if(!open)return;
    const dismiss=(event:Event)=>{
      if(event instanceof KeyboardEvent){if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}return;}
      const node=event.target as Node;if(!menu.current?.contains(node)&&!trigger.current?.contains(node))setOpen(false);
    };
    document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',dismiss);
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',dismiss);};
  },[open]);
  const configured = availability[target]?.installed!==false && (target !== 'acp' || !!profiles.acp?.executable);
  const apply = async () => {
    const api=window.codenode;
    if(!api||busy||loading||target===selected||!configured)return;
    if(useProjectStore.getState().root!==root)return;
    useBackendSwitchStore.setState({switching:true});setError('');
    try {
      const next=profiles[target]||{...backendConfig.defaults,backend:target,executable:(backendConfig.commands as Record<Backend,string>)[target],args:(backendConfig.defaultArgs as Partial<Record<Backend,string[]>>)[target]||[]};
      const result=await api.backendSave(root,root?'project':'machine',next as AgentBackendSettings);
      if(!result.ok)throw new Error(result.error||'切换失败');
      if(useProjectStore.getState().root!==root)return;
      if(hasHistory)useSessionStore.getState().newConversation({preserveDraft:true});
      setSelected(target);setOpen(false);window.dispatchEvent(new Event('codenode-backend-settings'));
      useUiStore.getState().setToast(`已切换到 ${labels[target]}${hasHistory?'，原对话已保留':''}`);
    } catch(e) {setOpen(true);setError(e instanceof Error?e.message:String(e));}
    finally{useBackendSwitchStore.setState({switching:false});}
  };
  return <div className="agent-switcher">
    <button ref={trigger} className="agent-switch-trigger" aria-label="选择 Agent" aria-haspopup="dialog" aria-expanded={open} disabled={busy||loading} title={busy?'任务运行或切换期间不能更换 Agent':'选择执行任务的 Agent'} onClick={()=>{setTarget(selected);setError('');setOpen(!open);}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 12v3M16 12v3M1 12v5M23 12v5"/></svg><span className="agent-switch-caption">Chat</span><span className="agent-switch-name">{shortLabel(selected)}</span><span aria-hidden="true">⌄</span></button>
    {error&&!open&&<span className="agent-switch-error" role="status">{error}</span>}
    {open&&createPortal(<div className={`glass-theme theme-${theme} agent-switch-layer`}><div ref={menu} className="agent-switch-menu" role="dialog" aria-label="切换 Agent" style={{...position,maxHeight:`calc(100vh - ${position.top+12}px)`}}>

      <div className="agent-switch-list" role="radiogroup" aria-label="可用 Agent" onKeyDown={event=>{
          if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
          event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const at=buttons.indexOf(document.activeElement as HTMLButtonElement),index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
          setTarget(buttons[index]?.dataset.backend as Backend);buttons[index]?.focus();
        }}>
        {backendConfig.backends.map(name=>{const backend=name as Backend,unavailable=availability[backend]?.installed===false;return <button key={backend} data-backend={backend} role="radio" aria-checked={selected===backend} disabled={unavailable} title={availability[backend]?.reason} className={target===backend&&target!==selected?'is-selected':''} onClick={()=>setTarget(backend)}><span>{shortLabel(backend)}{unavailable&&<span className="agent-unavailable"> · 不可用</span>}</span><span aria-hidden="true">{selected===backend?'✓':''}</span></button>;})}
      </div>
      {target!==selected&&<div className="agent-switch-confirm">
        <p>{!configured?'请先在高级设置中填写 ACP 命令和参数。':hasHistory?'切换会开启新对话，原对话和输入草稿会保留。':'选中不会立即切换，确认后用于下一次任务。'}</p>
        {error&&<p role="status">{error}</p>}
        <button className="agent-switch-apply" disabled={target===selected||busy||!configured} onClick={()=>void apply()}>{hasHistory?'新建对话并切换':'确认切换'}</button>
      </div>}
    </div></div>,document.body)}
  </div>;
}
