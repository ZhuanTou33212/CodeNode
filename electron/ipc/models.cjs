/**
 * 模型接入管理（models.json 落在 userData）：列表 / 保存 / 删除 / 切换当前模型。
 *
 * 为什么单独一个模块：这四条通道只依赖 modelStore + 配置，与窗口、工程、会话状态无关。
 * 依赖由 register(ctx) 显式传入，不再依赖 main.cjs 的模块级闭包 —— 这样"这条通道用到哪些状态"
 * 在签名上就能看清，也便于单独回归。
 */

const modelStore = require('../modelStore.cjs');

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
    const incoming = { ...model };
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
}

module.exports = { register };
