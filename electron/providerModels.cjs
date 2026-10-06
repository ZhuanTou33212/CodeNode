const { capabilities } = require('./modelEffort.cjs');
'use strict';
const { request } = require('./publicHttp.cjs');
const PROVIDERS = Object.freeze({
  deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com', list: '/models', protocol: 'openai' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', list: '/models', protocol: 'openai' },
  anthropic: { label: 'Anthropic', base: 'https://api.anthropic.com', list: '/v1/models', protocol: 'anthropic' },
  gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com', list: '/v1beta/models', protocol: 'gemini' },
  qwen: { label: '通义千问 / 百炼（国内）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', list: '/models', protocol: 'openai' },
  qwen_intl: { label: '百炼（新加坡）', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', list: '/models', protocol: 'openai' },
  kimi: { label: 'Kimi / Moonshot', base: 'https://api.moonshot.cn/v1', list: '/models', protocol: 'openai' },
  glm: { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', list: '/models', protocol: 'openai' },
  doubao: { label: '豆包 / 火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', list: '/models', protocol: 'openai' },
  baidu: { label: '百度文心 / 千帆', base: 'https://qianfan.baidubce.com/v2', list: '/models', protocol: 'openai' },
  siliconflow: { label: '硅基流动', base: 'https://api.siliconflow.cn/v1', list: '/models', protocol: 'openai' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', list: '/models', protocol: 'openai' },
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', list: '/models', protocol: 'openai' },
  mistral: { label: 'Mistral', base: 'https://api.mistral.ai/v1', list: '/models', protocol: 'openai' },
  xai: { label: 'xAI / Grok', base: 'https://api.x.ai/v1', list: '/models', protocol: 'openai' },
  minimax: { label: 'MiniMax（国内）', base: 'https://api.minimaxi.com/v1', list: '/models', protocol: 'openai' },
  minimax_intl: { label: 'MiniMax（国际）', base: 'https://api.minimax.io/v1', list: '/models', protocol: 'openai' },
  together: { label: 'Together AI', base: 'https://api.together.ai/v1', list: '/models', protocol: 'openai' },
});
async function discover(provider, key, transport = request, options = {}) {
  let spec = Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? PROVIDERS[provider] : null;
  let local = false;
  let identity = provider;
  if (provider === 'custom') {
    let url; try { url = new URL(String(options.apiBase || '')); } catch { throw new Error('请填写兼容服务的 API 地址'); }
    local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('远程服务须使用 HTTPS；本机服务可使用 HTTP，地址不能含密码或查询参数');
    const base = url.href.replace(/\/+$/, '');
    spec = { label: local ? '本地模型' : '兼容服务', base, list: '/models', protocol: 'openai' };
    identity = 'custom-' + require('crypto').createHash('sha256').update(base).digest('hex').slice(0, 12);
  }
  if (!spec) throw new Error('请选择 API Key 所属供应商');
  if (typeof key !== 'string' || (!local && !key.trim()) || /[\r\n]/.test(key) || key.length > 4096) throw new Error('请填写有效 API Key');
  const manual = String(options.modelId || '').trim();
  if (manual && (manual.length > 200 || /[\r\n]/.test(manual))) throw new Error('模型或部署 ID 无效');
  if (manual) return [{ id: identity + ':' + manual, model: manual, label: manual, provider, providerLabel: spec.label,
    apiBase: spec.base, protocol: spec.protocol, auth: local && !key.trim() ? 'none' : '',
    contextWindow: 128000, supportsEffort: false, vision: false, priceInput: 0, priceInputHit: 0, priceOutput: 0, enabled: true, manual: true }];
  const headers = /** @type {Record<string,string>} */ (spec.protocol === 'anthropic' ? { 'x-api-key': key.trim(), 'anthropic-version': '2023-06-01' }
    : spec.protocol === 'gemini' ? { 'x-goog-api-key': key.trim() } : { Authorization: 'Bearer ' + key.trim() });
  const found = new Map(); let page = ''; let pages = 0;
  do {
    const suffix = page ? (spec.protocol === 'gemini' ? '?pageToken=' : '?after_id=') + encodeURIComponent(page) : '';
    let result;
    try { result = await transport(spec.base + spec.list + suffix, { headers, timeoutMs: 15000, maxBytes: 1024 * 1024, allowPrivateHosts: local }); }
    catch { throw new Error('无法连接供应商，请检查网络后重试'); }
    if (result.status !== 200) throw new Error(result.status === 401 || result.status === 403 ? 'API Key 无效或没有模型列表权限' : result.status === 404 || result.status === 405 ? '供应商没有开放模型列表，请在下方填写模型或部署 ID' : '获取模型失败（HTTP ' + result.status + '）');
    let body; try { body = JSON.parse(result.text); } catch { throw new Error('供应商返回的模型列表格式无效'); }
    const rows = Array.isArray(body) ? body : spec.protocol === 'gemini' ? body.models : body.data;
    if (!Array.isArray(rows)) throw new Error('供应商返回的模型列表格式无效');
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (row.type && ['embedding', 'image', 'audio', 'transcription', 'rerank'].includes(row.type)) continue;
      const id = String(row.id || row.name || '').replace(/^models\//, '');
      if (!id || id.length > 200 || /[\r\n]/.test(id)) continue;
      if (spec.protocol === 'gemini' && !(row.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (provider === 'openai' && !/^(gpt-|chatgpt-|o[1-9])/i.test(id)) continue;
      if (provider === 'openai' && /image|realtime|audio|transcrib|tts|embedding/i.test(id)) continue;
      const modalities = row.input_modalities || row.modalities?.input || row.architecture?.input_modalities || [];
      const effort = capabilities({ ...row, model: id });
      found.set(id, { id: identity + ':' + id, model: id, label: row.display_name || row.displayName || row.name || id,
        provider, providerLabel: spec.label, apiBase: spec.base, protocol: spec.protocol,
        auth: local && !key.trim() ? 'none' : '',
        contextWindow: Number(row.context_window || row.context_length || row.inputTokenLimit) || 128000,
        ...effort, supportsEffort: effort.effortLevels.length > 0, vision: modalities.includes('image') || row.capabilities?.vision === true,
        priceInput: 0, priceInputHit: 0, priceOutput: 0, enabled: true });
    }
    page = spec.protocol === 'gemini' ? body.nextPageToken : body.has_more ? body.last_id : '';
    pages++;
  } while (page && pages < 10);
  if (page) throw new Error('模型列表分页超过上限，请稍后重试');
  if (!found.size) throw new Error('该 Key 未返回可用的对话模型');
  return [...found.values()];
}
module.exports = { PROVIDERS, discover };
