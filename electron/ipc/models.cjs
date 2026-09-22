/**
 * 模型接入管理（models.json 落在 userData）：列表 / 保存 / 删除 / 切换当前模型，
 * 以及 S13 新增的三条「让任何一家的 key 都能一次填对」的通道：
 *   models:presets       —— 主流厂商预设清单（地址 / 协议 / 认证头 / 参考模型）
 *   models:preset-apply  —— 按预设一次性写入若干模型条目（含密钥安全存储）
 *   models:test          —— 真发一次最小请求，把**供应商原话**的错误带给用户
 *   models:fetch         —— 拉取该厂商的模型列表（不知道模型 ID 也能用）
 *
 * 为什么单独一个模块：这组通道只依赖 modelStore + 配置 + 协议层，与窗口、工程、会话状态无关。
 * 依赖由 register(ctx) 显式传入，不再依赖 main.cjs 的模块级闭包 —— 这样"这条通道用到哪些状态"
 * 在签名上就能看清，也便于单独回归。
 */

const modelStore = require('../modelStore.cjs');
const modelProtocol = require('../modelProtocol.cjs');
const providerPresets = require('../providerPresets.cjs');

/** 10 秒内没回应就放弃（列模型 / 测连接都不该让 UI 无限转圈） */
const PROBE_TIMEOUT_MS = 10000;
const TEST_TIMEOUT_MS = 30000;

/** 从模型条目 + 全局配置拼出一次调用的 cfg（与 agent:chat 的合并口径保持一致） */
function cfgForModel(baseCfg, model) {
  const cfg = Object.assign({}, baseCfg, {
    apiBase: model.apiBase || baseCfg.apiBase,
    apiKey: model.apiKey || baseCfg.apiKey,
    model: model.model || baseCfg.model,
    protocol: modelProtocol.normalizeProtocol(model.protocol || baseCfg.protocol),
    auth: String(model.auth || baseCfg.auth || 'auto'),
    endpoint: String(model.endpoint || baseCfg.endpoint || 'standard'),
    maxTokensField: String(model.maxTokensField || baseCfg.maxTokensField || 'max_tokens'),
  });
  if (model.apiVersion) cfg.apiVersion = String(model.apiVersion);
  if (model.azureDeployment) cfg.azureDeployment = String(model.azureDeployment);
  // 「支持推理强度」不勾 = 该模型不下发 reasoning_effort（与 agent:chat 同一口径）
  if (model.supportsEffort === false) cfg.reasoningEffort = null;
  return cfg;
}

/** 常见的「填错了」形态 → 一句能直接照做的中文建议（不猜、只在能确定时给） */
function hintForError(status, text) {
  const body = String(text || '');
  if (status === 401 || status === 403) return '密钥无效或没有该模型的权限，请核对 API Key';
  if (status === 404) {
    return '地址或模型 ID 不对：检查 API 地址是否少/多了路径（如 /v1），Azure 的「模型 ID」要填部署名';
  }
  if (status === 400 && /reasoning_effort|thinking/i.test(body)) {
    return '该模型不接受 reasoning_effort：请在模型管理里取消勾选「支持推理强度」';
  }
  if (status === 400 && /stream_options|include_usage/i.test(body)) {
    return '该网关不认 stream_options.include_usage：可在 config/agent.properties 里设 agent.send_stream_options=false';
  }
  if (status === 429) return '触发限流：稍后重试或降低并发';
  return '';
}

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   agent: any,
 *   userDataDir: () => string,
 * }} ctx
 */
function register(ctx) {
  const { ipcMain, agent, userDataDir } = ctx;

  /** 每次调用都重新读盘：模型配置可能被 UI 或外部编辑器改动 */
  const loadStore = () => {
    const cfg = agent.loadConfig(null);
    return modelStore.getModels(userDataDir(), cfg);
  };

  ipcMain.handle('models:list', async () => {
    const store = loadStore();
    return { models: modelStore.toPublicModels(store.models), activeId: store.activeId };
  });

  ipcMain.handle('models:save', async (_event, model) => {
    if (!model || !model.id) return { ok: false, error: '缺少模型 id' };
    const userData = userDataDir();
    const store = loadStore();
    const existing = store.models.find((item) => item && item.id === model.id);
    const incoming = modelStore.normalizeModelInput({ ...model });
    // UI 不会回传已保存的密钥；空值表示保留主进程中的旧密钥。
    if (!String(incoming.apiKey || '').trim() && existing && existing.apiKey) incoming.apiKey = existing.apiKey;
    delete incoming.apiKeySet;
    const models = store.models.filter((m) => m.id !== incoming.id);
    models.push(incoming);
    modelStore.writeModels(userData, models, store.activeId || model.id);
    return { ok: true, models: modelStore.toPublicModels(models), activeId: store.activeId || model.id };
  });

  ipcMain.handle('models:delete', async (_event, id) => {
    const userData = userDataDir();
    const store = loadStore();
    const models = store.models.filter((m) => m.id !== id);
    const activeId = store.activeId === id ? (models[0] ? models[0].id : null) : store.activeId;
    modelStore.writeModels(userData, models, activeId);
    return { ok: true, models: modelStore.toPublicModels(models), activeId };
  });

  ipcMain.handle('models:active', async (_event, id) => {
    const userData = userDataDir();
    const store = loadStore();
    if (!store.models.some((m) => m.id === id)) return { ok: false, error: '模型不存在' };
    modelStore.writeModels(userData, store.models, id);
    return { ok: true, activeId: id };
  });

  /** 预设清单：UI 的「从预设添加」下拉直接吃这个（不含任何密钥） */
  ipcMain.handle('models:presets', async () => ({
    ok: true,
    regions: providerPresets.REGION_LABELS,
    presets: providerPresets.allPresets().map((preset) => ({
      id: preset.id,
      label: preset.label,
      region: preset.region,
      apiBase: preset.apiBase,
      protocol: presetProtocolOf(preset),
      auth: preset.auth || 'auto',
      endpoint: preset.endpoint || 'standard',
      apiVersion: preset.apiVersion || '',
      keyHint: preset.keyHint || '',
      docs: preset.docs || '',
      note: preset.note || '',
      local: preset.local === true,
      models: (preset.models || []).map((m) => ({ id: m.id, contextWindow: m.contextWindow || 0, vision: m.vision === true, supportsEffort: m.supportsEffort === true })),
    })),
  }));

  /**
   * 按预设写入模型条目。已存在的同 id 条目**覆盖**（用户改地址/换 key 后重按一遍即可），
   * activeId 缺省时把第一个新条目设为当前模型。
   */
  ipcMain.handle('models:preset-apply', async (_event, payload) => {
    const input = payload || {};
    const preset = providerPresets.findPreset(input.presetId);
    if (!preset) return { ok: false, error: '未知的厂商预设' };
    const userData = userDataDir();
    const store = loadStore();
    const entries = providerPresets.presetModels(preset, {
      apiBase: String(input.apiBase || preset.apiBase || '').trim(),
      apiKey: String(input.apiKey || (store.models.find((m) => m.provider === preset.id && m.apiKey) || {}).apiKey || ''),
    });
    if (!entries.length) return { ok: false, error: '该预设没有可添加的模型' };
    const incomingIds = new Set(entries.map((m) => m.id));
    const models = store.models.filter((m) => !incomingIds.has(m.id)).concat(entries);
    const activeId = store.activeId || entries[0].id;
    modelStore.writeModels(userData, models, activeId);
    return { ok: true, models: modelStore.toPublicModels(models), activeId, added: entries.length };
  });

  /**
   * 测连接：**真发一次最小请求**（不是「看地址像不像」）。
   * 失败时再发一次「最小形态」请求（不带 tools / reasoning_effort / stream_options）：
   *   - 最小形态也失败 → 密钥或地址不对（把供应商原话带回去）
   *   - 只有完整形态失败 → 是附加字段/协议的问题，hint 里给出该改哪个开关
   */
  ipcMain.handle('models:test', async (_event, id) => {
    const baseCfg = agent.loadConfig(null);
    const store = loadStore();
    const model = store.models.find((m) => m && m.id === id);
    if (!model) return { ok: false, error: '模型不存在' };
    const cfg = cfgForModel(baseCfg, model);
    const messages = [{ role: 'user', content: '只回复两个字母：OK' }];
    const started = Date.now();
    try {
      const res = await agent.chatCompletionStream(cfg, messages, () => {}, { timeoutMs: TEST_TIMEOUT_MS });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        reply: String((res && res.content) || '').slice(0, 200),
        usage: (res && res.usage) || null,
        protocol: modelProtocol.describeProtocol(cfg),
      };
    } catch (error) {
      const message = String((error && error.message) || error);
      const status = Number((/(\d{3})/.exec(message) || [])[1]) || 0;
      /** 最小对照请求：把「附加字段」这一层变量摘掉 */
      let minimal = null;
      try {
        const minimalCfg = Object.assign({}, cfg, { maxTokens: 32, reasoningEffort: null, sendStreamOptions: false });
        const res2 = await agent.chatCompletionStream(minimalCfg, messages, () => {}, { timeoutMs: TEST_TIMEOUT_MS });
        minimal = { ok: true, reply: String((res2 && res2.content) || '').slice(0, 120) };
      } catch (error2) {
        minimal = { ok: false, error: String((error2 && error2.message) || error2).slice(0, 300) };
      }
      return {
        ok: false,
        error: message.slice(0, 500),
        status,
        hint: hintForError(status, message),
        minimal,
        protocol: modelProtocol.describeProtocol(cfg),
      };
    }
  });

  /** 拉取模型列表：不用猜模型 ID，也不用去翻文档 */
  ipcMain.handle('models:fetch', async (_event, id) => {
    const baseCfg = agent.loadConfig(null);
    const store = loadStore();
    const model = store.models.find((m) => m && m.id === id);
    if (!model) return { ok: false, error: '模型不存在' };
    const cfg = cfgForModel(baseCfg, model);
    const request = modelProtocol.buildModelListRequest(cfg);
    if (!request) {
      return { ok: false, error: 'Azure OpenAI 没有「列出模型」端点：模型由「部署」决定，请直接填部署名' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(request.url, { method: request.method, headers: request.headers, signal: controller.signal });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, hint: hintForError(res.status, text) };
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, error: '响应不是 JSON，可能是地址指向了网页而不是 API 端点' };
      }
      const models = modelProtocol.parseModelList(request.protocol, json);
      if (!models.length) return { ok: false, error: '该端点没有返回可识别的模型列表' };
      return { ok: true, models: models.slice(0, 400), count: models.length };
    } catch (error) {
      const message = String((error && error.message) || error);
      return { ok: false, error: /abort/i.test(message) ? '拉取超时（10 秒）' : message.slice(0, 300), hint: /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message) ? '网络不可达：检查地址与代理设置' : '' };
    } finally {
      clearTimeout(timer);
    }
  });
}

/** 预设 → 协议（缺省 openai） */
function presetProtocolOf(preset) {
  return modelProtocol.normalizeProtocol(providerPresets.presetProtocol(preset));
}

module.exports = { register, cfgForModel, hintForError };
