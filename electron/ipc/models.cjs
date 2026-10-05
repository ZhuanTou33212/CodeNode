/**
 * 模型接入管理（models.json 落在 userData）：列表 / 保存 / 删除 / 切换当前模型。
 *
 * 为什么单独一个模块：这四条通道只依赖 modelStore + 配置，与窗口、工程、会话状态无关。
 * 依赖由 register(ctx) 显式传入，不再依赖 main.cjs 的模块级闭包 —— 这样"这条通道用到哪些状态"
 * 在签名上就能看清，也便于单独回归。
 */

const modelStore = require('../modelStore.cjs');
const providerModels = require('../providerModels.cjs');
const { randomUUID } = require('crypto');

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
    const store = modelStore.readUsableModels(userDataDir(), agent.loadConfig(null));
    return { models: modelStore.toPublicModels(store.models), activeId: store.activeId, modelAliases: store.modelAliases };
  });

  const pending = new Map();
  ipcMain.handle('models:discover', async (event, provider, apiKey, options) => {
    try {
      for (const [id, entry] of pending) if (entry.expires < Date.now() || entry.sender === event.sender.id) pending.delete(id);
      if (pending.size >= 16) return { ok: false, error: '连接请求过多，请稍后重试' };
      const models = await providerModels.discover(provider, apiKey, undefined, options || {});
      const ticket = randomUUID();
      pending.set(ticket, { sender: event.sender.id, models, apiKey: apiKey.trim(), expires: Date.now() + 600000 });
      const timer = setTimeout(() => pending.delete(ticket), 600000); timer.unref();
      event.sender.once('destroyed', () => { clearTimeout(timer); pending.delete(ticket); });
      return { ok: true, ticket, models };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('models:connect', async (event, ticket, selectedId) => {
    const entry = pending.get(ticket);
    if (!entry || entry.sender !== event.sender.id || entry.expires < Date.now()) return { ok: false, error: '连接已过期，请重新获取模型' };
    if (!entry.models.some((model) => model.id === selectedId)) return { ok: false, error: '请选择列表中的模型' };
    try {
      modelStore.saveConnection(userDataDir(), entry.models, entry.apiKey, selectedId);
      pending.delete(ticket);
      return { ok: true };
    } catch { return { ok: false, error: '无法安全保存 Key，原配置已保留' }; }
  });

  ipcMain.handle('models:save', async (_event, model) => {
    if (!model || !model.id) return { ok: false, error: '缺少模型 id' };
    const userData = userDataDir();
    const store = loadStore();
    const existing = store.models.find((item) => item && item.id === model.id);
    // 协议字段（OpenAI 兼容 / Claude / Gemini / Azure）只做取值归一，界面上不暴露
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
    try { modelStore.activateModel(userDataDir(), id); return { ok: true, activeId: id }; }
    catch { return { ok: false, error: '该模型 Key 不可用，请重新连接供应商' }; }
  });
}

module.exports = { register };
