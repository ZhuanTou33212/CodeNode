/**
 * ToolBridge：把主进程工具与渲染进程 UI 桥接起来（确认框 / 提问 / 界面操控）。
 *
 * 协议：
 *   主进程 → 渲染进程  webContents.send('tools:request', { id, type: 'confirm'|'ask'|'ui', ...payload })
 *   渲染进程 → 主进程  ipcRenderer.send('tools:response', { id, result })
 *   主进程   ipcMain.on('tools:response', ...)  按 id 路由并校验 sender
 */
'use strict';

const { ipcMain } = require('electron');

const TEST_MODE = !!process.env.CODENODE_TEST;
/** 测试模式下是否也放行 HIGH 级（破坏性）确认；默认不放行 —— 见 confirm() 的说明 */
const TEST_ALLOW_HIGH = /^(1|true|yes|on)$/i.test(String(process.env.CODENODE_TEST_ALLOW_HIGH || ''));
const REQUEST_TIMEOUT_MS = 180000;

let seq = 0;
/** 测试模式自动答复只提示一次，避免刷屏 */
let testModeWarned = false;

function makeBridge(sender, signal) {
  const pending = new Map(); // id -> { resolve, senderId, timer }
  let closed = false;
  function cleanup() {
    closed = true;
    ipcMain.removeListener('tools:response', onResponse);
    signal?.removeEventListener('abort', cleanup);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      try { sender.send('tools:request', { id, type: 'cancel' }); } catch {}
      entry.resolve(null);
    }
    pending.clear();
  }

  const onResponse = (_event, msg) => {
    if (!msg || msg.id == null) return;
    const p = pending.get(String(msg.id));
    if (!p) return;
    if (p.senderId != null && _event.sender && _event.sender.id !== p.senderId) return;
    clearTimeout(p.timer);
    pending.delete(String(msg.id));
    p.resolve(msg.result);
  };
  ipcMain.on('tools:response', onResponse);
  signal?.addEventListener('abort', cleanup, { once: true });
  if (signal?.aborted) cleanup();

  function request(type, payload) {
    const id = 'tool-' + Date.now().toString(36) + '-' + (++seq);
    return new Promise((resolve) => {
      const senderId = sender && !sender.isDestroyed() ? sender.id : null;
      if (closed || senderId == null) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, senderId, timer });
      try {
        sender.send('tools:request', { id, type, ...payload });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  }

  /**
   * 分级确认。返回 boolean。
   *
   * CODENODE_TEST 的边界（安全）：测试模式自动批准只覆盖**可回滚的写入**。HIGH 级
   * （破坏性 / 不可撤销：删除、强推、清理…）默认**拒绝**，要显式设
   * `CODENODE_TEST_ALLOW_HIGH=1` 才放行 —— 否则「测试环境」就是一条静默放行破坏性
   * 操作的通道（环境变量被误设到 CI / 打包流程时尤其危险）。
   * 注意这里只影响「用户答不答应」，不影响 capability 判定（越界路径、网络策略、
   * 只读上下文这些门都在 registry，与本函数无关）。
   */
  async function confirm(level, what, detail) {
    if (TEST_MODE) {
      const isHigh = String(level || '').toUpperCase() === 'HIGH';
      const approved = isHigh ? TEST_ALLOW_HIGH : true;
      if (!testModeWarned) {
        testModeWarned = true;
        try {
          console.warn(
            '[bridge] CODENODE_TEST=1：确认通道自动答复（HIGH 级别' +
              (TEST_ALLOW_HIGH ? '按 CODENODE_TEST_ALLOW_HIGH 放行' : '默认拒绝') + '）',
          );
        } catch {}
      }
      return approved;
    }
    const r = await request('confirm', { level, what, detail });
    return r && r.ok === true;
  }

  /** 向用户提问。返回回答字符串（取消为空）。 */
  async function askUser(question, options) {
    if (TEST_MODE) return '测试自动回答';
    const r = await request('ask', { question, options });
    return r && typeof r.answer === 'string' ? r.answer : '';
  }

  /** 界面操控。返回是否已接线执行。 */
  async function ui(action, args) {
    if (TEST_MODE) return false;
    const r = await request('ui', { action, args });
    return !!(r && r.applied);
  }

  return { confirm, askUser, ui, request, cleanup };
}

module.exports = { makeBridge };
