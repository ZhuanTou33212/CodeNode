/**
 * 用户可见的错误上报（#25(a)：`void asyncFn()` 无 catch）。
 *
 * 修复前 `WorkbenchDock` 里一片 `void autoResume()` / `void retryResume()`（`retryResume` 内部
 * 还会主动 `throw`），`chatStore.stop()` 里的 `void api.stopAgent(rid)` 也一样：IPC reject 时
 * 错误只出现在 devtools，界面「点了没反应」，用户既不知道失败也不知道为什么失败。
 *
 * 这里把「等 Promise + 失败必须变成用户可见提示」收成一个函数，所有 fire-and-forget 调用点共用。
 */

export type ErrorReporter = (message: string) => void;

function defaultReport(message: string): void {
  try {
    // eslint-disable-next-line no-console
    console.error('[codenode] ' + message);
  } catch {
    /* 无 console 的环境（极少）忽略 */
  }
}

export function describeFailure(error: unknown): string {
  // 注意 `String(new Error('')) === 'Error'`：Error 实例的空 message 必须显式判掉，
  // 否则「空消息错误」会渲染成和名字一样的 'Error'，对用户等于没有信息。
  if (error instanceof Error) {
    const message = String(error.message || '').trim();
    return message || '未知错误（Error 未带说明）';
  }
  const text = error === undefined || error === null ? '' : String(error).trim();
  return text || '未知错误';
}

export function reportError(label: string, error: unknown, report: ErrorReporter): string {
  const message = (label ? label + '：' : '') + describeFailure(error);
  report(message);
  return message;
}

/**
 * 执行一个异步操作；**失败绝不上抛**，而是转成用户可见的提示。
 * `onError` 返回 false 表示「调用方自己已经提示过了」——此时不再重复提示（但不吞掉错误）。
 */
export function fireAndReport(
  run: () => Promise<unknown> | unknown,
  label: string,
  report: ErrorReporter = defaultReport,
  onError?: (message: string) => boolean | void
): Promise<void> {
  return (async () => {
    try {
      await run();
    } catch (error) {
      const message = reportError(label, error, report);
      if (onError) onError(message);
    }
  })();
}
