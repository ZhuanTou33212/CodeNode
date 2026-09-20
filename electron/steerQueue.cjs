/**
 * steerQueue.cjs —— 用户插话（steering）队列（§4.2 的第二件事）
 *
 * 缺口：长任务（十几轮工具调用）跑偏时，此前**唯一的出口是整停** —— 停掉就丢掉了已经完成的
 * 全部上下文与进度，重启还得从头再来。有了插话队列，用户可以边跑边纠偏
 * （「别改 utils，只改 api 层」），主循环在下一轮把它作为 user 消息送进请求体。
 *
 * 语义（判据见 scripts/agent-steering-test.cjs）：
 *   - `push` 只在 run 存活时接受；run 已结束返回 `{accepted:false, reason:'run-ended'}` ——
 *     **绝不静默丢弃**（用户以为插上了、其实没插，比直接报错更糟）；
 *   - `push('   ')` 空内容拒绝（reason:'empty'）；
 *   - `drain` 一次性取走全部待插话：同一句话不会在两轮里重复进请求体；
 *   - `close` 关闭队列（run 收尾时调用），之后再 push 一律拒绝。
 *
 * 独立成模块（而不是写在 ipc/agent.cjs 里）是为了能在**不起 Electron** 的情况下被用例直接驱动。
 */
'use strict';

const MAX_STEER_CHARS = 2000;

/**
 * @returns {{push: (text: any) => {accepted: boolean, reason?: string, pending?: number}, drain: () => string[], close: () => void, readonly size: number, readonly closed: boolean}}
 */
function createSteerQueue() {
  /** @type {string[]} */
  const queue = [];
  let closed = false;
  return {
    push(text) {
      if (closed) return { accepted: false, reason: 'run-ended' };
      const value = String(text == null ? '' : text).trim();
      if (!value) return { accepted: false, reason: 'empty' };
      queue.push(value.length > MAX_STEER_CHARS ? value.slice(0, MAX_STEER_CHARS) : value);
      return { accepted: true, pending: queue.length };
    },
    drain() {
      return queue.splice(0, queue.length);
    },
    close() {
      closed = true;
    },
    get size() {
      return queue.length;
    },
    get closed() {
      return closed;
    },
  };
}

module.exports = { createSteerQueue, MAX_STEER_CHARS };
