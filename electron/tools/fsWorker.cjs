/**
 * fsWorker.cjs —— 文件遍历任务在 worker 线程里的执行入口（P7 收口）
 *
 * 为什么要有它：`scan_project` / `find_files` / `search_files` 都是**同步 fs 遍历**。
 * 只加「循环之间的取消检查点」还不够 ——
 *   ① 单次同步 fs 调用（读一个 2MB 文件算行数、`statSync` 撞上挂住的网络盘）根本不可打断；
 *   ② 整个遍历跑在**主线程**（Electron 主进程）里，扫一个 2 万文件的项目会把界面整个冻住。
 * 把任务挪进 worker 线程后：`worker.terminate()` 能在任意时刻真的杀掉它（包括同步 fs 中途），
 * 主线程的事件循环也始终可响应。
 *
 * 打包注意：本文件在 `package.json > build.asarUnpack` 名单里，会落到 `app.asar.unpacked`
 * 的**真实文件系统**上。因此它只能 require 同样被 unpack 的兄弟文件（`fsCore.cjs`）——
 * 多引一个 asar 内的模块会在**打包版**里 `MODULE_NOT_FOUND`，而开发模式与 CI 都看不出来。
 */
'use strict';

const { parentPort, isMainThread } = require('worker_threads');
const fsCore = require('./fsCore.cjs');

/** 回消息给主线程；通道已关闭时静默（主线程可能已经 terminate 我们了） */
function reply(message) {
  try {
    /** @type {any} */ (parentPort).postMessage(message);
  } catch {}
}

/**
 * 处理一条任务消息。worker 线程里同步执行是安全的（它不阻塞主线程），
 * 所以这里直接走 `runTaskSync`。
 * @param {any} raw
 */
function handle(raw) {
  const msg = raw || {};
  if (!fsCore.FS_TASKS.includes(String(msg.task))) {
    reply({ type: 'error', error: '未知文件任务：' + String(msg.task) });
    return;
  }
  const onProgress = (count) => reply({ type: 'progress', count });
  try {
    // 注意：函数（shouldStop）无法跨线程克隆 —— runner 下发前已经剥掉，取消靠 terminate 实现
    const payload = Object.assign({}, msg.payload || {}, { onProgress });
    const result = fsCore.runTaskSync(String(msg.task), payload);
    reply({ type: 'done', result });
  } catch (e) {
    reply({ type: 'error', error: String((e && e.message) || e) });
  }
}

if (!isMainThread && parentPort) {
  parentPort.on('message', handle);
}

module.exports = { handle };
