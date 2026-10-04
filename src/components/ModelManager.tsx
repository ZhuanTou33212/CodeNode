import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { useUsageStore, type ModelSpec } from '../store/usageStore';
const PROVIDERS = [['deepseek', 'DeepSeek'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini']];
export default function ModelManager() {
  const open = useUiStore(s => s.modelManagerOpen), close = useUiStore(s => s.closeModelManager);
  const [models, setModels] = useState<ModelSpec[]>([]), [choices, setChoices] = useState<ModelSpec[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [provider, setProvider] = useState('deepseek'), [key, setKey] = useState('');
  const [ticket, setTicket] = useState(''), [selected, setSelected] = useState(''), [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const epoch = useRef(0);
  const refresh = async () => {
    const result = await window.codenode?.modelsList();
    if (result) { setModels(result.models || []); setActive(result.activeId); }
    await useUsageStore.getState().loadModels();
  };
  useEffect(() => {
    const current = ++epoch.current;
    setKey(''); setTicket(''); setChoices([]); setQuery(''); setError(''); setBusy(false);
    if(open) void refresh().catch(() => { if(current === epoch.current) setError('无法读取模型配置，请检查配置文件'); });
    return () => { epoch.current++; };
  }, [open]);
  useEffect(() => {
    if(!open) return;
    const onKey = (e: KeyboardEvent) => { if(e.key === 'Escape' && !busy) close(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, close]);
  if(!open) return null;
  const discover = async () => {
    const current = ++epoch.current;
    setBusy(true); setError(''); setTicket(''); setChoices([]);
    try {
      const result = await window.codenode?.modelsDiscover(provider, key);
      if(current !== epoch.current) return;
      if(!result?.ok || !result.ticket) throw new Error(result?.error || '获取模型失败');
      setTicket(result.ticket); setChoices(result.models || []); setSelected(result.models?.[0]?.id || ''); setKey('');
    } catch(e) { if(current === epoch.current) setError(e instanceof Error ? e.message : '获取模型失败'); }
    finally { if(current === epoch.current) setBusy(false); }
  };
  const choose = async (id: string) => {
    if(ticket) { setSelected(id); return; }
    setBusy(true); setError('');
    try {
      const result = await window.codenode?.modelsActive(id);
      if(!result?.ok) throw new Error(result?.error || '切换失败');
      useUsageStore.getState().setModel(id); setActive(id);
    } catch(e) { setError(e instanceof Error ? e.message : '切换失败'); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true); setError('');
    try {
      const result = await window.codenode?.modelsConnect(ticket, selected);
      if(!result?.ok) throw new Error(result?.error || '连接失败');
      useUsageStore.getState().setModel(selected); await refresh(); setTicket(''); setChoices([]);
    } catch(e) { setError(e instanceof Error ? e.message : '连接失败'); }
    finally { setBusy(false); }
  };
  const list = ticket ? choices : models;
  const filtered = list.filter(m => (m.label + ' ' + m.model).toLowerCase().includes(query.toLowerCase()));
  return <div className="mm-mask" onClick={() => { if(!busy) close(); }}><div className="mm-dialog mm-connect-dialog" role="dialog" aria-modal="true" aria-label="管理模型" onClick={e => e.stopPropagation()}>
    <div className="mm-head"><span className="mm-title">管理模型</span><button className="mm-close" aria-label="关闭" disabled={busy} onClick={close}>✕</button></div>
    <div className="mm-connect-body">
      <p className="mm-intro">连接你的供应商，然后选择模型。</p>
      {models.some(m => m.apiKeyError) && <div className="mm-error" role="status">部分旧 Key 无法解密。请重新连接对应供应商；旧配置会保留。</div>}
      <div className="mm-provider-row">{PROVIDERS.map(([id,label]) => <button key={id} aria-pressed={provider === id} disabled={busy} className={provider === id ? 'active' : ''} onClick={() => { epoch.current++; setProvider(id); setKey(''); setTicket(''); setChoices([]); setError(''); }}>{label}</button>)}</div>
      <label className="mm-field"><span>API Key</span><div className="mm-key-row"><input className="mm-input" type="password" autoComplete="off" disabled={busy} value={key} placeholder="粘贴供应商的 API Key" onChange={e => { setKey(e.target.value); setTicket(''); setChoices([]); }} onKeyDown={e => { if(e.key === 'Enter' && key.trim() && !busy) void discover(); }} /><button className="mm-btn primary" disabled={busy || !key.trim()} onClick={() => void discover()}>{busy ? '处理中…' : '获取模型'}</button></div></label>
      <p className="mm-connect-note">Key 只发送给所选供应商；确认连接后加密保存在本机。</p>
      {error && <div className="mm-error" role="alert">{error}</div>}
      <div className="mm-model-heading"><strong>{ticket ? '可选模型' : '已连接模型'}</strong><span>{list.length} 个</span></div>
      <input className="mm-input" aria-label="搜索模型" placeholder="搜索模型…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="mm-choice-list" role="listbox" aria-label="模型列表">{filtered.map(m => <button role="option" aria-selected={ticket ? selected === m.id : active === m.id} className="mm-choice" key={m.id} disabled={busy || m.apiKeyError} onClick={() => void choose(m.id)}><span><strong>{m.label}</strong><small>{m.model}</small></span><span>{m.apiKeyError ? '需重新连接' : (ticket ? selected === m.id : active === m.id) ? '✓' : ''}</span></button>)}{!filtered.length && <div className="mm-empty">{list.length ? '没有匹配的模型' : '填写 Key，获取供应商提供的模型列表。'}</div>}</div>
    </div>
    <div className="mm-foot"><span className="mm-connect-note">实际调用权限以供应商为准。</span><div className="mm-foot-spacer" />{ticket && <button className="mm-btn primary" disabled={busy || !selected} onClick={() => void connect()}>连接并使用</button>}<button className="mm-btn" disabled={busy} onClick={close}>完成</button></div>
  </div></div>;
}
