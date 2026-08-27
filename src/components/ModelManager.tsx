import { useCallback, useEffect, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { useUsageStore, type ModelSpec } from '../store/usageStore';

function emptyModel(): ModelSpec {
  return {
    id: '',
    label: '',
    model: '',
    apiBase: 'https://api.deepseek.com',
    apiKey: '',
    contextWindow: 1_000_000,
    priceInput: 0.22,
    priceInputHit: 0.007,
    priceOutput: 0.66,
    supportsEffort: true,
    enabled: true,
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
        setForm({ ...(list.find((m) => m.id === current) || list[0]) });
        setIsNew(false);
      } else {
        setSelectedId(null);
        setForm(emptyModel());
        setIsNew(true);
      }
    } catch {}
  }, [selectedId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const save = async () => {
    if (!form.label.trim() || !form.model.trim()) return;
    setBusy(true);
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
      if (res && res.ok) {
        await refresh();
        await loadModels();
        if (res.activeId) setActiveId(res.activeId);
      }
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
      if (res && res.ok) {
        await refresh();
        await loadModels();
        if (res.activeId) setActiveId(res.activeId);
      }
    } finally {
      setBusy(false);
    }
  };

  const setActive = async () => {
    if (!selectedId) return;
    const api = window.codenode;
    const res = api && api.modelsActive ? await api.modelsActive(selectedId) : null;
    if (res && res.ok) setActiveId(selectedId);
  };

  const addNew = () => {
    setSelectedId(null);
    setForm(emptyModel());
    setIsNew(true);
  };

  const set = (k: keyof ModelSpec, v: string | number | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  const input = (k: keyof ModelSpec, placeholder: string, opts?: { num?: boolean; pw?: boolean }) => (
    <input
      className="mm-input"
      type={opts?.pw ? 'password' : opts?.num ? 'number' : 'text'}
      placeholder={placeholder}
      value={String(form[k] ?? '')}
      onChange={(e) => set(k, opts?.num ? Number(e.target.value) : e.target.value)}
    />
  );

  return (
    <div className="mm-mask" onClick={close}>
      <div className="mm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="mm-head">
          <span className="mm-title">管理模型</span>
          <button className="mm-close" onClick={close} title="关闭">
            ✕
          </button>
        </div>

        <div className="mm-body">
          <div className="mm-side">
            <div className="mm-side-list">
              {models.map((m) => (
                <div
                  key={m.id}
                  className={'mm-item' + (m.id === selectedId ? ' active' : '')}
                  onClick={() => {
                    setSelectedId(m.id);
                    setForm({ ...m });
                    setIsNew(false);
                  }}
                >
                  <span className="mm-item-label">
                    {m.label}
                    {m.id === activeId && <span className="mm-item-active">在用</span>}
                  </span>
                  <span className="mm-item-sub">{m.model}</span>
                </div>
              ))}
              {models.length === 0 && <div className="mm-empty">暂无模型，点击下方「新增」添加</div>}
            </div>
            <button className="mm-add" onClick={addNew}>
              + 新增模型
            </button>
          </div>

          <div className="mm-form">
            <div className="mm-field">
              <label>显示名称</label>
              {input('label', '例如：DeepSeek V4 Flash')}
            </div>
            <div className="mm-field">
              <label>模型 ID</label>
              {input('model', '例如：deepseek-v4-flash')}
            </div>
            <div className="mm-field">
              <label>API 地址（URL）</label>
              {input('apiBase', '例如：https://api.deepseek.com')}
            </div>
            <div className="mm-field">
              <label>API Key</label>
              {input('apiKey', 'sk-…', { pw: true })}
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

            <div className="mm-checks">
              <label className="mm-check">
                <input type="checkbox" checked={!!form.supportsEffort} onChange={(e) => set('supportsEffort', e.target.checked)} />
                支持推理强度
              </label>
              <label className="mm-check">
                <input type="checkbox" checked={form.enabled !== false} onChange={(e) => set('enabled', e.target.checked)} />
                启用
              </label>
            </div>
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
