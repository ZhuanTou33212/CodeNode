import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';

type Settings = { provider: string; model: string; base: string; dim: number; dimensions: string; backend: string; key: string; hasKey: boolean; rerankEnabled: boolean; rerankExternal: boolean; bm25K1: number; bm25B: number; vectorWeight: number };
const defaults: Settings = { provider: 'none', model: '', base: '', dim: 4096, dimensions: '', backend: 'memory', key: '', hasKey: false, rerankEnabled: false, rerankExternal: false, bm25K1: 1.35, bm25B: 0.72, vectorWeight: 0.35 };

export default function RagSettingsPanel() {
  const root = useProjectStore((s) => s.root);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setSaved(false);
    if (!root || !window.codenode?.agentConfig) return;
    void window.codenode.agentConfig(root).then((config) => {
      if (!alive || !config.rag) return;
      setSettings({ ...defaults, ...config.rag, key: '' });
    }).catch((error) => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [root]);

  const change = (patch: Partial<Settings>) => { setSettings((current) => ({ ...current, ...patch })); setSaved(false); setMessage(''); };
  const payload = () => ({ provider: settings.provider, model: settings.model, base: settings.base, dim: settings.dim, dimensions: settings.dimensions, backend: settings.backend, key: settings.key, bm25K1: settings.bm25K1, bm25B: settings.bm25B, vectorWeight: settings.vectorWeight });
  const run = async (save: boolean) => {
    if (!root || busy) return;
    const api = window.codenode;
    if (!api) return;
    setBusy(true);
    try {
      const result = save ? await api.ragSave(root, payload()) : await api.ragCheck(root, payload());
      if (result.ok) {
        setMessage(save ? '已保存。下次检索会按新配置重建索引；旧 SQLite 向量不会混用。' : settings.provider === 'none' ? '验证通过：当前使用 BM25，无需向量模型。' : `验证通过：${'dimension' in result ? result.dimension || settings.dim : settings.dim} 维`);
        if (save) { setSaved(true); setSettings((current) => ({ ...current, key: '', hasKey: current.hasKey || !!current.key })); }
      } else setMessage(result.error || '验证失败');
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };

  if (!root) return <div className="dock-empty">先选择项目，再查看检索设置。</div>;
  const semantic = settings.provider === 'ollama' || settings.provider === 'openai';
  return <div className="dock-rag-settings">
    <div className="dock-run-toolbar"><div><strong>项目检索设置</strong><span className="dock-file-meta">默认无需模型或外部服务；设置保存到项目 .codenode/agent.properties</span></div></div>
    <div className="dock-rag-note">默认使用 BM25、标量与代码关系检索，不加载向量模型。哈希向量可选，但主要依赖词项重合，不能理解跨表达语义。</div>
    <label>检索模式<select value={settings.provider} onChange={(event) => change({ provider: event.target.value, backend: event.target.value === 'none' ? 'memory' : settings.backend, model: event.target.value === 'local' || event.target.value === 'none' ? '' : settings.model, base: event.target.value === 'ollama' && !settings.base ? 'http://localhost:11434' : settings.base })}>
      <option value="none">默认 · BM25 / 标量</option><option value="local">可选 · BM25 + 哈希向量</option><option value="ollama">语义 · Ollama</option><option value="openai">语义 · OpenAI 兼容</option>
    </select></label>
    <label>向量存储<select value={settings.backend} disabled={settings.provider === 'none'} onChange={(event) => change({ backend: event.target.value })}><option value="memory">内存 · 小工程默认</option><option value="sqlite">SQLite · 跨会话保留</option>{settings.backend === 'milvus' && <option value="milvus">Milvus · 在配置文件中管理</option>}</select></label>
    <label>BM25 词频饱和 k1<input type="number" min={0.1} max={3} step={0.05} value={settings.bm25K1} onChange={(event) => change({ bm25K1: Number(event.target.value) })} /></label>
    <label>BM25 长度归一化 b<input type="number" min={0} max={1} step={0.05} value={settings.bm25B} onChange={(event) => change({ bm25B: Number(event.target.value) })} /></label>
    <label>向量融合权重<input type="number" min={0} max={1} step={0.05} value={settings.vectorWeight} disabled={settings.provider === 'none'} onChange={(event) => change({ vectorWeight: Number(event.target.value) })} /></label>
    <div className="dock-rag-note">k1、b 和融合权重可按项目调整。当前默认值是起点；建议用项目中的检索问题比较命中率后再修改。权重 0 表示只按 BM25 排名。</div>
    {semantic && <>
      <label>服务地址<input value={settings.base} placeholder={settings.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com/v1'} onChange={(event) => change({ base: event.target.value })} /></label>
      <label>嵌入模型<input value={settings.model} placeholder="模型名称" onChange={(event) => change({ model: event.target.value })} /></label>
      {settings.provider === 'openai' && <><label>API Key<input type="password" value={settings.key} placeholder={settings.hasKey ? '已配置；留空沿用现有 Key' : '填写 API Key'} onChange={(event) => change({ key: event.target.value })} /></label><label>请求维度（可选）<input value={settings.dimensions} placeholder="留空使用模型原生维度" onChange={(event) => change({ dimensions: event.target.value })} /></label><div className="dock-rag-note">API Key 将以明文保存到本项目的 .codenode/agent.properties；请按项目凭据管理该文件。</div></>}
      <div className="dock-rag-note">测试连接会发送一条固定测试文本；检索时，查询与候选片段会发送到该嵌入端点。</div>
    </>}
    {settings.rerankEnabled && <div className="dock-rag-note">当前还启用了{settings.rerankExternal ? '外部' : '本地'}重排端点，候选片段会发送到该端点。重排配置由项目属性文件管理。</div>}
    <label>索引维度<input type="number" min={256} max={8192} value={settings.dim} onChange={(event) => change({ dim: Number(event.target.value) })} /></label>
    <div className="dock-rag-note">更改模型、维度或存储方式后会重建对应向量索引。SQLite 会使用由模型和维度决定的独立数据库。项目文件较多时，首次语义索引可能调用多次嵌入服务。</div>
    <div className="dock-rag-actions"><button onClick={() => void run(false)} disabled={busy || settings.backend === 'milvus'}>{busy ? '验证中…' : '测试连接与维度'}</button><button className="dock-primary" onClick={() => void run(true)} disabled={busy || settings.backend === 'milvus'}>{busy ? '处理中…' : '验证并保存'}</button></div>
    {message && <div className={saved ? 'dock-rag-success' : 'dock-rag-message'} role="status">{message}</div>}
  </div>;
}
