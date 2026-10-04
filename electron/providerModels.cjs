'use strict';
const { request } = require('./publicHttp.cjs');
const PROVIDERS = Object.freeze({
  deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com', list: '/models', protocol: 'openai' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', list: '/models', protocol: 'openai' },
  anthropic: { label: 'Anthropic', base: 'https://api.anthropic.com', list: '/v1/models', protocol: 'anthropic' },
  gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com', list: '/v1beta/models', protocol: 'gemini' },
});
async function discover(provider, key, transport = request) {
  const spec = Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? PROVIDERS[provider] : null;
  if (!spec) throw new Error('请选择 API Key 所属供应商');
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key) || key.length > 4096) throw new Error('请填写有效 API Key');
  const headers = /** @type {Record<string,string>} */ (spec.protocol === 'anthropic' ? { 'x-api-key': key.trim(), 'anthropic-version': '2023-06-01' }
    : spec.protocol === 'gemini' ? { 'x-goog-api-key': key.trim() } : { Authorization: 'Bearer ' + key.trim() });
  const found = new Map(); let page = ''; let pages = 0;
  do {
    const suffix = page ? (spec.protocol === 'gemini' ? '?pageToken=' : '?after_id=') + encodeURIComponent(page) : '';
    let result;
    try { result = await transport(spec.base + spec.list + suffix, { headers, timeoutMs: 15000, maxBytes: 1024 * 1024 }); }
    catch { throw new Error('无法连接供应商，请检查网络后重试'); }
    if (result.status !== 200) throw new Error(result.status === 401 || result.status === 403 ? 'API Key 无效或没有模型列表权限' : '获取模型失败（HTTP ' + result.status + '）');
    let body; try { body = JSON.parse(result.text); } catch { throw new Error('供应商返回的模型列表格式无效'); }
    const rows = spec.protocol === 'gemini' ? body.models : body.data;
    if (!Array.isArray(rows)) throw new Error('供应商返回的模型列表格式无效');
    for (const row of rows) {
      const id = String(row.id || row.name || '').replace(/^models\//, '');
      if (!id || id.length > 200 || /[\r\n]/.test(id)) continue;
      if (spec.protocol === 'gemini' && !(row.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (provider === 'openai' && !/^(gpt-|chatgpt-|o[1-9])/i.test(id)) continue;
      if (provider === 'openai' && /image|realtime|audio|transcrib|tts|embedding/i.test(id)) continue;
      const modalities = row.input_modalities || row.modalities?.input || [];
      const effort = row.supported_reasoning_efforts || row.reasoning_efforts || [];
      found.set(id, { id: provider + ':' + id, model: id, label: row.display_name || row.displayName || id,
        provider, providerLabel: spec.label, apiBase: spec.base, protocol: spec.protocol,
        contextWindow: Number(row.context_window || row.inputTokenLimit) || 128000,
        supportsEffort: effort.length > 0, vision: modalities.includes('image'),
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
