import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { useUsageStore, type ModelSpec } from '../store/usageStore';

/** 协议：openai 兼容是绝大多数厂商（DeepSeek / Qwen / Kimi / GLM / OpenRouter…）的通用档 */
const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容（默认）' },
  { id: 'anthropic', label: 'Anthropic Claude 原生' },
  { id: 'gemini', label: 'Google Gemini 原生' },
];

const AUTHS = [
  { id: 'auto', label: '自动（按协议）' },
  { id: 'bearer', label: 'Authorization: Bearer' },
  { id: 'x-api-key', label: 'x-api-key（Anthropic）' },
  { id: 'api-key', label: 'api-key（Azure）' },
  { id: 'x-goog-api-key', label: 'x-goog-api-key（Gemini）' },
  { id: 'none', label: '无鉴权（本地服务）' },
];

const MAX_TOKENS_FIELDS = [
  { id: 'max_tokens', label: 'max_tokens（默认）' },
  { id: 'max_completion_tokens', label: 'max_completion_tokens（o 系 / GPT-5）' },
];

type PresetState = { id: string; label: string; region: 'cn' | 'intl' | 'local'; apiBase: string; protocol: string; auth: string; endpoint: string; apiVersion?: string; keyHint?: string; docs?: string; note?: string; local?: boolean; models: Array<{ id: string; contextWindow: number; vision: boolean; supportsEffort: boolean }> };
type TestResult = { ok: boolean; latencyMs?: number; reply?: string; error?: string; hint?: string; minimal?: { ok: boolean; reply?: string; error?: string } | null; protocol?: { protocolLabel?: string; authLabel?: string } };

function emptyModel(): ModelSpec {
  return {
    id: '',
    label: '',
    model: '',
    apiBase: 'https://api.deepseek.com',
    apiKey: '',
    apiKeySet: false,
    contextWindow: 1_000_000,
    priceInput: 0.22,
    priceInputHit: 0.007,
    priceOutput: 0.66,
    supportsEffort: true,
    vision: false,
    enabled: true,
    protocol: 'openai',
    auth: 'auto',
    endpoint: 'standard',
    apiVersion: '',
    azureDeployment: '',
    maxTokensField: 'max_tokens',
    provider: '',
    providerLabel: '',
  };
}

export default function ModelManager() {
  const open = useUiStore((s) => s.modelManagerOpen);
  const close = useUiStore((s) => s.closeModelManager);
  const loadModels = useUsageStore((s) => s.loadModels);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<ModelSpec>(emptyModel());
  const [isNew, setIsNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [presets, setPresets] = useState<PresetState[]>([]);
  const [regions, setRegions] = useState<Record<string, string>>({});
  const [presetId, setPresetId] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<Array<{ id: string; label: string }> | null>(null);

  const refresh = useCallback(async () => {
    const api = window.codenode;
    if (!api || !api.modelsList) return;
    try {
      const res = await api.modelsList();
      const list = (res.models || []).filter((m) => m && m.id);
      setModels(list);
      setActiveId(res.activeId || null);
      if (list.length) {
        const current = selectedId && list.some((m) => m.id === selectedId) ? selectedId : res.activeId || list[0].id;
        setSelectedId(current);
        setForm({ ...emptyModel(), ...(list.find((m) => m.id === current) || list[0]) });
        setIsNew(false);
      } else {
        setSelectedId(null);
        setForm(emptyModel());
        setIsNew(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取模型配置');
    }
  }, [selectedId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  /** 预设清单只在打开时取一次（纯静态数据，不涉及密钥） */
  useEffect(() => {
    const api = window.codenode;
    if (!open || !api || !api.modelsPresets) return;
    void api.modelsPresets().then((res) => {
      if (res && res.ok) {
        setPresets((res.presets || []) as PresetState[]);
        setRegions(res.regions || {});
      }
    });
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const grouped = useMemo(() => {
    const order: Array<keyof typeof regions | string> = ['cn', 'intl', 'local'];
    return order
      .map((key) => ({ key: String(key), label: regions[String(key)] || String(key), items: presets.filter((p) => p.region === key) }))
      .filter((group) => group.items.length > 0);
  }, [presets, regions]);

  if (!open) return null;

  const save = async () => {
    if (!form.label.trim() || !form.model.trim()) return;
    setBusy(true);
    setError('');
    const api = window.codenode;
    try {
      const payload: ModelSpec = {
        ...form,
        id: isNew ? form.id || form.model.trim() : form.id,
        label: form.label.trim(),
        model: form.model.trim(),
        apiBase: form.apiBase?.trim() || 'https://api.deepseek.com',
        apiKey: form.apiKey || '',
        contextWindow: Number(form.contextWindow) || 1_000_000,
        priceInput: Number(form.priceInput) || 0,
        priceInputHit: Number(form.priceInputHit) || 0,
        priceOutput: Number(form.priceOutput) || 0,
      };
      const res = api && api.modelsSave ? await api.modelsSave(payload) : null;
      if (!res?.ok) throw new Error(res?.error || '保存失败');
      if (res && res.ok) {
        await refresh();
        await loadModels();
        if (res.activeId) setActiveId(res.activeId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    setBusy(true);
    const api = window.codenode;
    try {
      const res = api && api.modelsDelete ? await api.modelsDelete(selectedId) : null;
      if (!res?.ok) throw new Error(res?.error || '删除失败');
      if (res && res.ok) {
        await refresh();
        await loadModels();
        if (res.activeId) setActiveId(res.activeId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async () => {
    if (!selectedId) return;
    const api = window.codenode;
    try {
      const res = api && api.modelsActive ? await api.modelsActive(selectedId) : null;
      if (!res?.ok) throw new Error('无法切换模型');
      setActiveId(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法切换模型');
    }
  };

  /** 按预设预填表单：地址 / 协议 / 认证 / 模型 ID / 上下文 / 视觉 / 思考链一次到位 */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const first = preset.models[0];
    setForm((prev) => ({
      ...prev,
      id: '',
      provider: preset.id,
      providerLabel: preset.label,
      label: preset.label + (first ? ' · ' + first.id : ''),
      model: first ? first.id : prev.model,
      apiBase: preset.apiBase,
      protocol: preset.protocol || 'openai',
      auth: preset.auth || 'auto',
      endpoint: preset.endpoint || 'standard',
      apiVersion: preset.apiVersion || '',
      contextWindow: first && first.contextWindow ? first.contextWindow : prev.contextWindow,
      vision: first ? first.vision : prev.vision,
      supportsEffort: first ? first.supportsEffort : prev.supportsEffort,
      // 预设走的是「新增」路径：这里没有已保存的密钥，别让占位文案误导成「留空就沿用旧密钥」
      apiKeySet: false,
    }));
    setIsNew(true);
    setTest(null);
    setFetched(null);
  };

  /** 一次把该厂商预设里的模型全加进来（密钥沿用表单里已填的） */
  const addPresetAll = async () => {
    if (!presetId) return;
    const api = window.codenode;
    if (!api || !api.modelsPresetApply) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.modelsPresetApply({ presetId, apiBase: form.apiBase?.trim(), apiKey: form.apiKey || '' });
      if (!res?.ok) throw new Error(res?.error || '添加失败');
      await refresh();
      await loadModels();
      if (res.activeId) setActiveId(res.activeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '添加失败');
    } finally {
      setBusy(false);
    }
  };

  /** 测连接：主进程真发一次最小请求，失败时把供应商原话带回来 */
  const testConnection = async () => {
    if (!selectedId) return;
    const api = window.codenode;
    if (!api || !api.modelsTest) return;
    setTesting(true);
    setTest(null);
    try {
      const res = await api.modelsTest(selectedId);
      setTest(res as TestResult);
    } catch (cause) {
      setTest({ ok: false, error: cause instanceof Error ? cause.message : '测试失败' });
    } finally {
      setTesting(false);
    }
  };

  /** 拉模型列表：不用猜模型 ID（Azure 无此端点，会返回明确提示） */
  const fetchModels = async () => {
    if (!selectedId) return;
    const api = window.codenode;
    if (!api || !api.modelsFetch) return;
    setFetching(true);
    setFetched(null);
    try {
      const res = await api.modelsFetch(selectedId);
      if (res && res.ok) setFetched(res.models || []);
      else setTest({ ok: false, error: res?.error || '拉取失败', hint: res?.hint });
    } catch (cause) {
      setTest({ ok: false, error: cause instanceof Error ? cause.message : '拉取失败' });
    } finally {
      setFetching(false);
    }
  };

  const addNew = () => {
    setSelectedId(null);
    setForm(emptyModel());
    setIsNew(true);
    setPresetId('');
    setTest(null);
    setFetched(null);
  };

  const set = (k: keyof ModelSpec, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const input = (k: keyof ModelSpec, placeholder: string, opts?: { num?: boolean; pw?: boolean }) => (
    <input
      className="mm-input"
      type={opts?.pw ? 'password' : opts?.num ? 'number' : 'text'}
      placeholder={placeholder}
      value={String(form[k] ?? '')}
      onChange={(e) => set(k, opts?.num ? Number(e.target.value) : e.target.value)}
    />
  );

  const select = (k: keyof ModelSpec, options: Array<{ id: string; label: string }>) => (
    <select className="mm-input" value={String(form[k] ?? '')} onChange={(e) => set(k, e.target.value)}>
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.label}
        </option>
      ))}
    </select>
  );

  const isAzure = form.endpoint === 'azure';

  return (
    <div className="mm-mask" onClick={close}>
      <div className="mm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="mm-head">
          <span className="mm-title">管理模型</span>
          <button className="mm-close" onClick={close} title="关闭">
            ✕
          </button>
        </div>

        {error && <div role="alert" className="mm-error">{error}</div>}
        <div className="mm-body">
          <div className="mm-side">
            <div className="mm-side-list">
              {models.map((m) => (
                <div
                  key={m.id}
                  className={'mm-item' + (m.id === selectedId ? ' active' : '')}
                  onClick={() => {
                    setSelectedId(m.id);
                    setForm({ ...emptyModel(), ...m });
                    setIsNew(false);
                    setTest(null);
                    setFetched(null);
                  }}
                >
                  <span className="mm-item-label">
                    {m.label}
                    {m.id === activeId && <span className="mm-item-active">在用</span>}
                  </span>
                  <span className="mm-item-sub">
                    {m.protocol && m.protocol !== 'openai' ? <span className="mm-tag">{m.protocol === 'anthropic' ? 'Claude' : 'Gemini'}</span> : null}
                    {m.model}
                  </span>
                </div>
              ))}
              {models.length === 0 && <div className="mm-empty">暂无模型，点击下方「新增」添加</div>}
            </div>
            <button className="mm-add" onClick={addNew}>
              + 新增模型
            </button>
          </div>

          <div className="mm-form">
            <div className="mm-preset">
              <select
                className="mm-input"
                value={presetId}
                onChange={(e) => applyPreset(e.target.value)}
                title="选择厂商后自动填好地址、协议、认证头与参考模型（Anthropic / Gemini / Azure 会自动切换协议）"
              >
                <option value="">从预设添加：选择厂商…</option>
                {grouped.map((group) => (
                  <optgroup key={group.key} label={group.label}>
                    {group.items.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button className="mm-btn" onClick={addPresetAll} disabled={!presetId || busy} title="把该厂商预设里的模型全部加入（密钥用下面已填的）">
                全部加入
              </button>
            </div>
            {presetId && presets.find((p) => p.id === presetId)?.note ? (
              <div className="mm-hint">{presets.find((p) => p.id === presetId)?.note}</div>
            ) : null}

            <div className="mm-field">
              <label>显示名称</label>
              {input('label', '例如：DeepSeek V4 Flash')}
            </div>
            <div className="mm-field">
              <label>模型 ID</label>
              {input('model', '例如：deepseek-v4-flash / claude-sonnet-4-5 / gemini-2.5-pro')}
            </div>
            <div className="mm-field">
              <label>API 地址（URL）</label>
              {input('apiBase', '例如：https://api.deepseek.com')}
            </div>
            <div className="mm-field">
              <label>API Key</label>
                {input('apiKey', form.apiKeySet ? '已保存，留空保持不变' : 'sk-…', { pw: true })}
            </div>

            <div className="mm-section">
              <div className="mm-section-title">接入协议（Claude / Gemini / Azure 无需手改，预设已自动选好）</div>
              <div className="mm-grid">
                <div className="mm-field">
                  <label>协议</label>
                  {select('protocol', PROTOCOLS)}
                </div>
                <div className="mm-field">
                  <label>认证头</label>
                  {select('auth', AUTHS)}
                </div>
              </div>
              <div className="mm-grid">
                <div className="mm-field">
                  <label>输出上限字段</label>
                  {select('maxTokensField', MAX_TOKENS_FIELDS)}
                </div>
                <div className="mm-field">
                  <label>端点风格</label>
                  <select
                    className="mm-input"
                    value={isAzure ? 'azure' : 'standard'}
                    onChange={(e) => {
                      const azure = e.target.value === 'azure';
                      setForm((f) => ({ ...f, endpoint: azure ? 'azure' : 'standard', auth: azure ? 'api-key' : f.auth, apiVersion: azure ? f.apiVersion || '2024-10-21' : '' }));
                    }}
                  >
                    <option value="standard">标准</option>
                    <option value="azure">Azure OpenAI</option>
                  </select>
                </div>
              </div>
              {isAzure && (
                <div className="mm-grid">
                  <div className="mm-field">
                    <label>部署名（deployment）</label>
                    {input('azureDeployment', '留空则用「模型 ID」')}
                  </div>
                  <div className="mm-field">
                    <label>API 版本</label>
                    {input('apiVersion', '2024-10-21')}
                  </div>
                </div>
              )}
            </div>

            <div className="mm-grid">
              <div className="mm-field">
                <label>上下文窗口（tokens）</label>
                {input('contextWindow', '1000000', { num: true })}
              </div>
              <div className="mm-field">
                <label>输入价 $/1M</label>
                {input('priceInput', '0.22', { num: true })}
              </div>
              <div className="mm-field">
                <label>缓存命中价 $/1M</label>
                {input('priceInputHit', '0.007', { num: true })}
              </div>
              <div className="mm-field">
                <label>输出价 $/1M</label>
                {input('priceOutput', '0.66', { num: true })}
              </div>
            </div>
            <div className="mm-hint">价格留 0 = 不参与成本统计（人民币计价的厂商建议留 0，避免把 ¥ 记成 $）</div>

            <div className="mm-checks">
              <label className="mm-check">
                <input type="checkbox" checked={!!form.supportsEffort} onChange={(e) => set('supportsEffort', e.target.checked)} />
                支持推理强度
              </label>
              <label className="mm-check" title="开启后可在对话里粘贴 / 拖入 / 选择图片，模型会收到多模态内容">
                <input type="checkbox" checked={!!form.vision} onChange={(e) => set('vision', e.target.checked)} />
                视觉（图片输入）
              </label>
              <label className="mm-check">
                <input type="checkbox" checked={form.enabled !== false} onChange={(e) => set('enabled', e.target.checked)} />
                启用
              </label>
            </div>

            {test && (
              <div className={'mm-status ' + (test.ok ? 'ok' : 'err')} role="status">
                {test.ok ? (
                  <>
                    连接正常 · {test.latencyMs}ms · {test.protocol?.protocolLabel || ''} / {test.protocol?.authLabel || ''}
                    {test.reply ? <> · 回复：{test.reply}</> : null}
                  </>
                ) : (
                  <>
                    <div>连接失败：{test.error}</div>
                    {test.hint ? <div className="mm-status-hint">建议：{test.hint}</div> : null}
                    {test.minimal ? (
                      <div className="mm-status-hint">
                        {test.minimal.ok
                          ? '最小请求（不带工具/思考链/流式用量）可通 → 问题出在附加字段或协议上'
                          : '最小请求也不通 → 多半是密钥或地址不对：' + (test.minimal.error || '')}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            )}

            {fetched && (
              <div className="mm-model-list">
                <div className="mm-section-title">该厂商可用模型（{fetched.length}）· 点击填入模型 ID</div>
                <div className="mm-model-items">
                  {fetched.slice(0, 200).map((m) => (
                    <button
                      key={m.id}
                      className="mm-model-item"
                      onClick={() => setForm((f) => ({ ...f, model: m.id, label: f.label || m.id }))}
                      title={m.id}
                    >
                      {m.id}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mm-foot">
          {!isNew && (
            <>
              <button className="mm-btn danger" onClick={remove} disabled={busy}>
                删除
              </button>
              <button className="mm-btn" onClick={setActive} disabled={busy || selectedId === activeId}>
                设为当前模型
              </button>
              <button className="mm-btn" onClick={testConnection} disabled={testing || busy} title="真发一次最小请求（只花几个 token）">
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button className="mm-btn" onClick={fetchModels} disabled={fetching || busy} title="从该厂商拉取模型列表（Azure 无此端点）">
                {fetching ? '拉取中…' : '拉取模型列表'}
              </button>
            </>
          )}
          <div className="mm-foot-spacer" />
          <button className="mm-btn" onClick={close}>
            关闭
          </button>
          <button className="mm-btn primary" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
