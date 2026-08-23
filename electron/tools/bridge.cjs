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
const REQUEST_TIMEOUT_MS = 180000;

let seq = 0;

function makeBridge(sender) {
  const pending = new Map(); // id -> { resolve, senderId, timer }

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

  function request(type, payload) {
    const id = 'tool-' + Date.now().toString(36) + '-' + (++seq);
    return new Promise((resolve) => {
      const senderId = sender && !sender.isDestroyed() ? sender.id : null;
      if (senderId == null) {
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

  /** 分级确认。返回 boolean。 */
  async function confirm(level, what, detail) {
    if (TEST_MODE) return true;
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

  return { confirm, askUser, ui, request, cleanup: () => ipcMain.removeListener('tools:response', onResponse) };
}

module.exports = { makeBridge };
