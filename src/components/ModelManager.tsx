import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { useUsageStore, type ModelSpec } from '../store/usageStore';

const PROVIDERS = [
  ['deepseek', 'DeepSeek'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini'],
  ['qwen', '通义千问 / 百炼（国内）'], ['qwen_intl', '百炼（新加坡）'], ['kimi', 'Kimi / Moonshot'],
  ['glm', '智谱 GLM'], ['doubao', '豆包 / 火山方舟'], ['baidu', '百度文心 / 千帆'], ['siliconflow', '硅基流动'],
  ['openrouter', 'OpenRouter'], ['groq', 'Groq'], ['mistral', 'Mistral'], ['xai', 'xAI / Grok'],
  ['minimax', 'MiniMax（国内）'], ['minimax_intl', 'MiniMax（国际）'], ['together', 'Together AI'], ['custom', '自定义供应商'],
] as const;

type ProviderGroup = { key: string; provider: string; label: string; apiBase: string; protocol: string; models: ModelSpec[] };
const providerLabel = (id: string) => PROVIDERS.find(item => item[0] === id)?.[1] || id || '自定义供应商';
const providerOf = (model: ModelSpec) => model.provider || (/deepseek/i.test(model.apiBase || model.model) ? 'deepseek' : 'custom');
const groupKeyOf = (model: ModelSpec) => model.providerKey || (providerOf(model) === 'custom' ? `custom:${model.protocol || 'openai'}:${String(model.apiBase || '').replace(/\/+$/, '').toLowerCase()}` : providerOf(model));
const groupsOf = (models: ModelSpec[]): ProviderGroup[] => {
  const groups = new Map<string, ProviderGroup>();
  for (const model of models) {
    const key = groupKeyOf(model), provider = providerOf(model);
    const group = groups.get(key) || { key, provider, label: model.providerLabel || providerLabel(provider), apiBase: model.apiBase || '', protocol: model.protocol || 'openai', models: [] };
    group.models.push(model); groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
};

export default function ModelManager() {
  const open = useUiStore(s => s.modelManagerOpen), close = useUiStore(s => s.closeModelManager), target = useUiStore(s => s.modelConnectionTarget);
  const activeId = useUsageStore(s => s.modelId);
  const [models, setModels] = useState<ModelSpec[]>([]), [choices, setChoices] = useState<ModelSpec[]>([]);
  const [provider, setProvider] = useState('deepseek'), [providerName, setProviderName] = useState('');
  const [key, setKey] = useState(''), [apiBase, setApiBase] = useState(''), [protocol, setProtocol] = useState('openai'), [modelId, setModelId] = useState('');
  const [ticket, setTicket] = useState(''), [selected, setSelected] = useState(''), [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState(''), [editingKey, setEditingKey] = useState(false);
  const epoch = useRef(0);
  const groups = groupsOf(models);
  const activeGroup = adding ? undefined : groups.find(group => group.provider === provider && (provider !== 'custom' || group.apiBase.replace(/\/+$/, '') === apiBase.replace(/\/+$/, '') && group.protocol === protocol));
  const connected = activeGroup?.models || [];
  const saved = connected.find(model => model.id === activeId) || connected[0];
  const savedPreview = saved?.apiKeyPreview || '';
  const maskedTyped = key.length > 12 ? key.slice(0, 8) + '*****' + key.slice(-4) : '*'.repeat(key.length);
  const displayKey = editingKey ? key : key ? maskedTyped : preview || savedPreview;
  const displayedModels = ticket ? choices : connected;

  const clearDiscovery = () => { epoch.current++; setTicket(''); setChoices([]); setSelected(''); setPreview(''); setError(''); };
  const selectGroup = (group: ProviderGroup) => {
    clearDiscovery(); setAdding(false); setProvider(group.provider); setProviderName(group.label); setApiBase(group.apiBase); setProtocol(group.protocol || 'openai'); setModelId(''); setKey(''); setEditingKey(false);
  };
  const refresh = async () => {
    const result = await window.codenode?.modelsList();
    const list = (result?.models || []) as ModelSpec[];
    setModels(list); await useUsageStore.getState().loadModels(); return list;
  };

  useEffect(() => {
    const current = ++epoch.current;
    setKey(''); setPreview(''); setEditingKey(false); setTicket(''); setChoices([]); setSelected(''); setError(''); setBusy(false); setAdding(false);
    if (!open) return () => { epoch.current++; };
    void refresh().then(list => {
      if (current !== epoch.current) return;
      const groups = groupsOf(list);
      const requested = target ? groups.find(group => group.provider === target.provider && (target.provider !== 'custom' || group.apiBase === target.apiBase)) : null;
      const active = groups.find(group => group.models.some(model => model.id === useUsageStore.getState().modelId));
      const group = requested || active || groups[0];
      if (group) selectGroup(group);
      else { setAdding(true); setProvider('deepseek'); setProviderName('DeepSeek'); setApiBase(''); setProtocol('openai'); }
    }).catch(() => { if (current === epoch.current) setError('无法读取模型配置，请检查配置文件'); });
    return () => { epoch.current++; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) close(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, close]);

  if (!open) return null;
  const discover = async () => {
    const current = ++epoch.current;
    setBusy(true); setError(''); setTicket(''); setChoices([]);
    try {
      const result = await window.codenode?.modelsDiscover(provider, key, { apiBase, modelId, protocol, providerLabel: providerName.trim() || undefined });
      if (current !== epoch.current) return;
      if (!result?.ok || !result.ticket) throw new Error(result?.error || '获取模型失败');
      setPreview(result.apiKeyPreview || maskedTyped || savedPreview); setEditingKey(false); setTicket(result.ticket); setChoices((result.models || []) as ModelSpec[]);
      setSelected(result.models?.find(model => model.model === target?.model)?.id || result.models?.[0]?.id || ''); setKey('');
    } catch (reason) { if (current === epoch.current) setError(reason instanceof Error ? reason.message : '获取模型失败'); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const connect = async () => {
    if (!ticket || !selected) return;
    setBusy(true); setError('');
    try {
      const result = await window.codenode?.modelsConnect(ticket, selected);
      if (!result?.ok) throw new Error(result?.error || '保存供应商失败');
      await refresh();
      if (!await useUsageStore.getState().setModel(selected)) throw new Error('供应商已保存，但模型未能激活');
      useUiStore.setState({ modelConnectionTarget: null }); setTicket(''); setChoices([]); setPreview(''); setAdding(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存供应商失败'); }
    finally { setBusy(false); }
  };
  const activate = async (id: string) => {
    setBusy(true); setError('');
    if (!await useUsageStore.getState().setModel(id)) setError('模型切换失败');
    else { setSelected(id); useUiStore.setState({ modelConnectionTarget: null }); await refresh(); }
    setBusy(false);
  };
  const startAdd = () => { clearDiscovery(); setAdding(true); setProvider('custom'); setProviderName(''); setApiBase(''); setProtocol('openai'); setModelId(''); setKey(''); setEditingKey(false); };
  const changeProvider = (id: string) => { clearDiscovery(); setProvider(id); setProviderName(providerLabel(id)); setApiBase(''); setProtocol(id === 'anthropic' ? 'anthropic' : id === 'gemini' ? 'gemini' : 'openai'); setModelId(''); setKey(''); setEditingKey(false); };
  const keyless = provider === 'custom' && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(apiBase);
  const canDiscover = !!(key.trim() || savedPreview || keyless) && (provider !== 'custom' || !!apiBase.trim());

  return <div className="mm-mask" onClick={() => { if (!busy) close(); }}>
    <div className="mm-dialog mm-connect-dialog mm-provider-dialog" role="dialog" aria-modal="true" aria-label="模型设置" onClick={event => event.stopPropagation()}>
      <aside className="mm-provider-sidebar">
        <div className="mm-provider-brand"><h2>模型设置</h2><p>供应商凭据由旗下模型共享</p></div>
        <div className="mm-provider-list" aria-label="已配置供应商">
          {groups.map(group => <button key={group.key} className={!adding && activeGroup?.key === group.key ? 'active' : ''} onClick={() => selectGroup(group)} disabled={busy}>
            <span className="mm-provider-dot" data-ready={group.models.some(model => model.apiKeySet || model.auth === 'none')} />
            <span><strong>{group.label}</strong><small>{group.models.length} 个模型</small></span>
          </button>)}
          {!groups.length && <div className="mm-provider-empty">尚未配置供应商</div>}
        </div>
        <button className={`mm-provider-add${adding ? ' active' : ''}`} onClick={startAdd} disabled={busy}>＋ 添加供应商</button>
      </aside>

      <section className="mm-provider-detail">
        <header className="mm-provider-head"><div><h3>{adding ? '添加供应商' : activeGroup?.label || providerLabel(provider)}</h3><p>{adding ? '配置一次 Key，之后模型切换自动复用。' : 'API Key 对该供应商下的全部模型生效。'}</p></div><button className="mm-close" aria-label="关闭" disabled={busy} onClick={close}>✕</button></header>
        <div className="mm-provider-body">
          {target && !savedPreview && <div className="mm-error" role="status">{target.label} 所属供应商尚未配置可用凭据。</div>}
          {models.some(model => model.apiKeyError) && <div className="mm-error" role="status">部分旧 Key 无法解密，请更新对应供应商。</div>}

          {adding && <label className="mm-field"><span>供应商</span><select className="mm-input" aria-label="供应商" disabled={busy} value={provider} onChange={event => changeProvider(event.target.value)}>{PROVIDERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
          {provider === 'custom' && <div className="mm-grid mm-provider-custom-grid">
            <label className="mm-field"><span>供应商名称</span><input className="mm-input" aria-label="供应商名称" disabled={busy} value={providerName} placeholder="例如公司中转站" onChange={event => { setProviderName(event.target.value); clearDiscovery(); }} /></label>
            <label className="mm-field"><span>API 格式</span><select className="mm-input" aria-label="API 格式" disabled={busy} value={protocol} onChange={event => { setProtocol(event.target.value); clearDiscovery(); }}><option value="openai">OpenAI Compatible</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option></select></label>
          </div>}
          {provider === 'custom' && <label className="mm-field"><span>Base URL</span><input className="mm-input" aria-label="Base URL" disabled={busy} value={apiBase} placeholder="例如 https://gateway.example.com/v1" onChange={event => { setApiBase(event.target.value); clearDiscovery(); }} /></label>}
          {!adding && activeGroup?.apiBase && <div className="mm-provider-readonly"><span>Base URL</span><code>{activeGroup.apiBase}</code></div>}

          <label className="mm-field"><span>API Key</span><div className="mm-key-row"><input className="mm-input" aria-label="API Key" type={editingKey ? 'password' : 'text'} autoComplete="off" disabled={busy} value={displayKey} placeholder={savedPreview ? '已配置；留空继续使用' : keyless ? '本机服务可留空' : '粘贴供应商 API Key'} onFocus={() => { setEditingKey(true); setKey(''); setPreview(''); }} onBlur={() => setEditingKey(false)} onChange={event => { setKey(event.target.value); clearDiscovery(); }} onKeyDown={event => { if (event.key === 'Enter' && !busy && canDiscover) void discover(); }} /><button className="mm-btn primary" disabled={busy || !canDiscover} onClick={() => void discover()}>{busy ? '连接中…' : savedPreview ? '刷新模型' : '连接'}</button></div>{savedPreview && <small className="mm-provider-shared-note">已保存供应商凭据；切换下方模型无需再次输入。</small>}</label>

          <details className="mm-connect-note"><summary>手动模型</summary><label className="mm-field"><span>模型或部署 ID</span><input className="mm-input" aria-label="模型或部署 ID" disabled={busy} value={modelId} placeholder="供应商未开放模型列表时填写" onChange={event => { setModelId(event.target.value); clearDiscovery(); }} /></label></details>
          {error && <div className="mm-error" role="alert">{error}</div>}

          <div className="mm-model-heading"><div><strong>{ticket ? '选择要添加的模型' : '模型列表'}</strong><small>{displayedModels.length ? `${displayedModels.length} 个模型` : '连接供应商后显示模型'}</small></div>{ticket && <button className="mm-btn primary" disabled={!selected || busy} onClick={() => void connect()}>保存并使用</button>}</div>
          <div className="mm-provider-model-list" role="listbox" aria-label="模型列表">
            {displayedModels.map(model => <button role="option" aria-selected={(ticket ? selected : activeId) === model.id} key={model.id} disabled={busy} onClick={() => ticket ? setSelected(model.id) : void activate(model.id)}>
              <span><strong>{model.label}</strong><small>{model.model}</small></span><span className="mm-model-status">{(ticket ? selected : activeId) === model.id ? '✓' : ''}</span>
            </button>)}
            {!displayedModels.length && <div className="mm-empty">暂无模型。填写供应商凭据后获取模型列表。</div>}
          </div>
        </div>
        <footer className="mm-provider-foot"><span>凭据使用系统安全存储加密。</span><button className="mm-btn" disabled={busy} onClick={close}>完成</button></footer>
      </section>
    </div>
  </div>;
}
