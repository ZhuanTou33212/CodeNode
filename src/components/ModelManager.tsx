import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { useUsageStore, type ModelSpec } from '../store/usageStore';
const PROVIDERS = [['deepseek', 'DeepSeek'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini'], ['qwen', '通义千问 / 百炼（国内）'], ['qwen_intl', '百炼（新加坡）'], ['kimi', 'Kimi / Moonshot'], ['glm', '智谱 GLM'], ['doubao', '豆包 / 火山方舟'], ['baidu', '百度文心 / 千帆'], ['siliconflow', '硅基流动'], ['openrouter', 'OpenRouter'], ['groq', 'Groq'], ['mistral', 'Mistral'], ['xai', 'xAI / Grok'], ['minimax', 'MiniMax（国内）'], ['minimax_intl', 'MiniMax（国际）'], ['together', 'Together AI'], ['custom', '其他兼容服务 / 本地模型']];
export default function ModelManager() {
  const open = useUiStore(s => s.modelManagerOpen), close = useUiStore(s => s.closeModelManager);
  const [models, setModels] = useState<ModelSpec[]>([]), [choices, setChoices] = useState<ModelSpec[]>([]);
  const [provider, setProvider] = useState('deepseek'), [key, setKey] = useState('');
  const [apiBase, setApiBase] = useState(''), [modelId, setModelId] = useState('');
  const [ticket, setTicket] = useState(''), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const epoch = useRef(0);
  const refresh = async () => {
    const result = await window.codenode?.modelsList();
    if (result) { setModels(result.models || []); }
    await useUsageStore.getState().loadModels();
  };
  useEffect(() => {
    const current = ++epoch.current;
    setKey(''); setTicket(''); setChoices([]); setError(''); setBusy(false);
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
      const result = await window.codenode?.modelsDiscover(provider, key, { apiBase, modelId });
      if(current !== epoch.current) return;
      if(!result?.ok || !result.ticket) throw new Error(result?.error || '获取模型失败');
      setTicket(result.ticket); setChoices(result.models || []); setSelected(result.models?.[0]?.id || ''); setKey('');
    } catch(e) { if(current === epoch.current) setError(e instanceof Error ? e.message : '获取模型失败'); }
    finally { if(current === epoch.current) setBusy(false); }
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
  return <div className="mm-mask" onClick={() => { if(!busy) close(); }}><div className="mm-dialog mm-connect-dialog" role="dialog" aria-modal="true" aria-label="管理模型" onClick={e => e.stopPropagation()}>
    <div className="mm-head"><span className="mm-title">管理模型</span><button className="mm-close" aria-label="关闭" disabled={busy} onClick={close}>✕</button></div>
    <div className="mm-connect-body">

      {models.some(m => m.apiKeyError) && <div className="mm-error" role="status">旧 Key 已失效，需重新连接。</div>}
      <label className="mm-field"><span>供应商</span><select className="mm-input" aria-label="供应商" disabled={busy} value={provider} onChange={e => { epoch.current++; setProvider(e.target.value); setKey(''); setTicket(''); setChoices([]); setError(''); setApiBase(''); setModelId(''); }}>{PROVIDERS.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      {provider === 'custom' && <label className="mm-field"><span>API 地址</span><input className="mm-input" aria-label="API 地址" disabled={busy} value={apiBase} placeholder="例如 https://服务地址/v1 或 http://localhost:11434/v1" onChange={e => { setApiBase(e.target.value); setTicket(''); setChoices([]); }} /></label>}
      <label className="mm-field"><span>API Key</span><div className="mm-key-row"><input className="mm-input" type="password" autoComplete="off" disabled={busy} value={key} placeholder={provider === 'custom' ? '本机服务可留空；远程服务需填写 Key' : '粘贴供应商的 API Key'} onChange={e => { setKey(e.target.value); setTicket(''); setChoices([]); }} onKeyDown={e => { if(e.key === 'Enter' && (key.trim() || provider === 'custom') && !busy) void discover(); }} /><button className="mm-btn primary" disabled={busy || (!key.trim() && provider !== 'custom')} onClick={() => void discover()}>{busy ? '处理中…' : modelId.trim() ? '添加模型' : '连接'}</button></div></label>
      <details className="mm-connect-note"><summary>高级</summary><label className="mm-field"><span>模型或部署 ID（选填）</span><input className="mm-input" aria-label="模型或部署 ID" disabled={busy} value={modelId} placeholder="使用供应商控制台显示的模型/部署 ID" onChange={e => { setModelId(e.target.value); setTicket(''); setChoices([]); }} /></label><p>手动添加不会验证调用权限，连接后以实际调用结果为准。</p></details>

      {error && <div className="mm-error" role="alert">{error}</div>}
      {ticket && <><div className="mm-model-heading"><strong>选择模型</strong></div><div className="mm-choice-list" role="listbox" aria-label="模型列表">{choices.map(m => <button role="option" aria-selected={selected === m.id} className="mm-choice" key={m.id} disabled={busy} onClick={() => setSelected(m.id)}><span>{m.label}</span><span>{selected === m.id ? '✓' : ''}</span></button>)}</div></>}
    </div>
    <div className="mm-foot"><div className="mm-foot-spacer" />{ticket && <button className="mm-btn primary" disabled={busy || !selected} onClick={() => void connect()}>连接并使用</button>}<button className="mm-btn" disabled={busy} onClick={close}>完成</button></div>
  </div></div>;
}
