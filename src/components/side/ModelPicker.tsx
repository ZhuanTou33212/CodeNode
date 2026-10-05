import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUsageStore, type ReasoningEffort } from '../../store/usageStore';
import { useUiStore } from '../../store/uiStore';


export default function ModelPicker({ busy }: { busy: boolean }) {
  const { models, modelId, effort, setModel, setEffort, loadModels } = useUsageStore();
  const model = models.find(item => item.id === modelId) || models[0];
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const theme = useUiStore(s => s.theme);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - (innerWidth >= 600 ? 480 : 304))), bottom: innerHeight - rect.top + 8 }); };
    place(); window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') { setOpen(false); setSettings(null); trigger.current?.focus(); } return; }
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target) && !flyout.current?.contains(target)) { setOpen(false); setSettings(null); }
    };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); };
  }, [open]);
  const visible = models.filter(item => (item.label + ' ' + item.model).toLowerCase().includes(query.toLowerCase()));
  const levels = model?.effortLevels || [];
  const right = position.left + 296;
  const settingsLeft = right + 170 < innerWidth ? right + 4 : Math.max(8, position.left - 174);
  return <div className="pp-model-picker">
    <button ref={trigger} className="pp-model" aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen(!open); setSettings(null); }} title={model?.label}>{model?.label || '选择模型'}{model?.supportsEffort && levels.length ? ` · ${effort}` : ''}<span>⌄</span></button>
    {open && createPortal(<div className={`glass-theme theme-${theme} hermes-picker-layer`}>
      <div ref={menu} className="hermes-model-menu" role="dialog" aria-label="模型选择" style={{ left: position.left, bottom: position.bottom }}>
        <input autoFocus aria-label="搜索对话模型" placeholder="搜索模型" value={query} onChange={event => { setQuery(event.target.value); setSettings(null); }} />
        <div className="hermes-model-list" onScroll={() => setSettings(null)}>
          {[...new Set(visible.map(item => item.providerLabel || item.provider || '已连接'))].map(group => <section key={group}><div className="hermes-provider">{group}</div>{visible.filter(item => (item.providerLabel || item.provider || '已连接') === group).map(item => <div className="hermes-model-row" key={item.id}>
            <button disabled={switching} className={item.id === modelId ? 'active' : ''} onClick={async () => { setSwitching(true); const selected = await setModel(item.id); setSwitching(false); setSettings(null); if (selected || useUiStore.getState().modelManagerOpen) setOpen(false); }}><span>{item.label}</span><span>{`${item.id === modelId ? '✓ ' : ''}${item.apiKeyError ? '需重新连接' : ''}`}</span></button>
            {item.id === modelId && (item.effortLevels?.length || 0) > 0 && <button className="hermes-settings-trigger" aria-label="模型推理设置" aria-expanded={!!settings} onMouseEnter={event => setSettings(event.currentTarget.getBoundingClientRect())} onClick={event => setSettings(settings ? null : event.currentTarget.getBoundingClientRect())}>›</button>}
          </div>)}</section>)}
          {!visible.length && <p>没有匹配的模型</p>}
        </div>
        <div className="hermes-model-footer"><button disabled={busy} onClick={() => { setSettings(null); void loadModels(); }}>↻ 刷新模型</button><button onClick={() => { setOpen(false); setSettings(null); useUiStore.getState().openModelManager(); }}>⚙ 管理模型…</button></div>
      </div>
      {settings && model?.supportsEffort && <div ref={flyout} className="hermes-effort-menu" role="group" aria-label="推理强度" style={{ left: settingsLeft, top: Math.max(8, Math.min(settings.top, innerHeight - (levels.length * 34 + 45))) }}><div className="hermes-provider">Reasoning effort</div>{levels.map(level => <button key={level} aria-pressed={effort === level} disabled={busy} onClick={() => setEffort(level)}><span>{level}</span><span>{effort === level ? '✓' : ''}</span></button>)}</div>}
    </div>, document.body)}
  </div>;
}
