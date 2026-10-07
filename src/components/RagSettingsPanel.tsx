import { useEffect, useState } from 'react';
import ragUiConfig from '../../config/ui.rag.json';
import { useProjectStore } from '../store/projectStore';

type Settings = { enabled: boolean; strictValidation: boolean; milvusAddress:string;milvusCollection:string;milvusToken:string;hasMilvusToken:boolean;provider: string; model: string; base: string; dim: number; dimensions: string; backend: string; key: string; hasKey: boolean; rerankEnabled: boolean; rerankExternal: boolean; bm25K1: number; bm25B: number; vectorWeight: number };
const defaults: Settings = {...ragUiConfig.defaults, milvusAddress:'',milvusCollection:'',milvusToken:'',hasMilvusToken:false, model: '', base: '', dim: 4096, dimensions: '', key: '', hasKey: false, rerankEnabled: false, rerankExternal: false, bm25K1: 1.35, bm25B: 0.72, vectorWeight: 0.35 };

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
      setSettings({ ...defaults, ...config.rag, key: '',milvusToken:'' });
    }).catch((error) => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [root]);

  const change = (patch: Partial<Settings>) => { setSettings((current) => ({ ...current, ...patch })); setSaved(false); setMessage(''); };
  const payload = () => ({ enabled: settings.enabled, strictValidation: settings.strictValidation, provider: settings.provider, model: settings.model, base: settings.base, dim: settings.dim, dimensions: settings.dimensions, backend: settings.backend,milvusAddress:settings.milvusAddress,milvusCollection:settings.milvusCollection,milvusToken:settings.milvusToken, key: settings.key, bm25K1: settings.bm25K1, bm25B: settings.bm25B, vectorWeight: settings.vectorWeight });
  const run = async (save: boolean) => {
    if (!root || busy) return;
    const api = window.codenode;
    if (!api) return;
    setBusy(true);
    try {
      const result = save ? await api.ragSave(root, payload()) : await api.ragCheck(root, payload());
      if (result.ok) {
        setMessage(save ? '已保存项目设置。' : !settings.enabled || settings.provider === 'none' ? '本地配置验证通过，无需连接向量服务。' : `验证通过：${'dimension' in result ? result.dimension || settings.dim : settings.dim} 维`);
        if (save) { setSaved(true); setSettings((current) => ({ ...current, key: '',milvusToken:'',hasMilvusToken:current.hasMilvusToken||!!current.milvusToken, hasKey: current.hasKey || !!current.key })); }
      } else setMessage(result.error || '验证失败');
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };

  if (!root) return <div className="dock-empty">先选择项目，再查看检索设置。</div>;
  const semantic = settings.provider === 'ollama' || settings.provider === 'openai';
  return <div className="dock-rag-settings">
    <div className="dock-run-toolbar"><div><strong>项目检索与校验扩展</strong><span className="dock-file-meta">设置保存到当前项目，日间与夜间共用</span></div></div>
    <div className="dock-rag-note">编码任务优先搜索符号、读取文件、修改和测试。本地检索按需调用，不额外调用模型拆解问题；画布属性读取始终独立可用。</div>
    <label>本地项目检索<select aria-label="本地项目检索" value={String(settings.enabled)} disabled={busy} onChange={event => change({ enabled: event.target.value === 'true' })}><option value="true">开启 · 按需使用</option><option value="false">关闭</option></select></label>
    <label>严格答案校验<select aria-label="严格答案校验" value={String(settings.strictValidation)} disabled={busy} onChange={event => change({ strictValidation: event.target.value === 'true' })}><option value="false">关闭（默认）</option><option value="true">开启 · 证据问答场景</option></select></label>
    {settings.strictValidation && <div className="dock-rag-note">启用后会额外调用当前模型核对答案，可能增加耗时并阻止证据不足的答复。</div>}
    <label>向量检索扩展<select aria-label="向量检索扩展" disabled={busy || !settings.enabled} value={settings.provider} onChange={(event) => change({ provider: event.target.value, model: event.target.value === 'local' || event.target.value === 'none' ? '' : settings.model, base: event.target.value === 'ollama' && !settings.base ? 'http://localhost:11434' : settings.base })}>
      <option value="none">关闭（默认）· 本地词法检索</option><option value="local">可选 · 哈希向量</option><option value="ollama">可选 · Ollama</option><option value="openai">可选 · OpenAI 兼容</option>
    </select></label>
    <label>向量存储<select aria-label="向量存储" value={settings.backend} disabled={busy} onChange={event=>change({backend:event.target.value})}>{ragUiConfig.backends.map(backend=><option value={backend.id} key={backend.id}>{backend.label}</option>)}</select></label>
    {settings.provider==='none'&&<div className="dock-rag-note">向量扩展已关闭，存储选择会保留，开启扩展后生效。哈希向量仅匹配词项；SQLite 和 Milvus 需另行安装支持。</div>}
    {settings.backend==='milvus'&&<><label>Milvus 服务地址<input aria-label="Milvus 服务地址" value={settings.milvusAddress} placeholder="http://127.0.0.1:19530" onChange={event=>change({milvusAddress:event.target.value})}/></label><label>集合名称（可选）<input value={settings.milvusCollection} placeholder="留空按项目自动创建" onChange={event=>change({milvusCollection:event.target.value})}/></label><label>Milvus Token（可选）<input type="password" value={settings.milvusToken} placeholder={settings.hasMilvusToken?'已配置；留空沿用':'填写服务令牌'} onChange={event=>change({milvusToken:event.target.value})}/></label><div className="dock-rag-note">启用 Milvus 需要外部服务和当前版本的 SDK 支持。令牌保存到项目属性文件；实际存储连接会在首次索引时检查。</div></>}
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
    <div className="dock-rag-actions"><button onClick={() => void run(false)} disabled={busy}>{busy ? '验证中…' : '测试配置'}</button><button className="dock-primary" onClick={() => void run(true)} disabled={busy || settings.enabled && settings.provider !== 'none' && settings.backend === 'milvus'}>{busy ? '处理中…' : '验证并保存'}</button></div>
    {message && <div className={saved ? 'dock-rag-success' : 'dock-rag-message'} role="status">{message}</div>}
  </div>;
}
