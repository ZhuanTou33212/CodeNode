/**
 * AgentToolResult：工具执行结果 = 确定性文本 + 结构化数据 + （S5）失败分类 + （A1）模型可见投影
 *
 * 兼容性承诺：`ok` / `text` / `data` 三个字段**保持不变**——24 个既有工具里 60+ 处
 * `AgentToolResult.ok/error(text, data)` 零改动继续工作；需要分类的新代码改用
 * `AgentToolResult.failure(code, message, data)`（写 `data.code` 并附 `failure` 对象）
 * 或 `AgentToolResult.partial(text, data, failed)`。
 *
 * `modelContent`（token 效率审计 §4 P0-2）：**唯一进入 LLM 上下文的那份内容**。
 * 此前 `buildToolContent` 一律 `result.text` + `JSON.stringify(result.data)` 双份回灌，
 * 而 `find_files` / `search_files` / `execute_shell` 的 `data` 恰恰是 `text` 里已经有的那份列表/输出
 * —— 结果被发了两遍，随后的 LLM 压缩还要为这份重复付一次费。
 * 现在：`modelContent != null` → 只发它（`data` 仍照旧给 UI / 审计 / 回放用，不自动追加）。
 * `modelContent == null`（缺省，60+ 处既有调用）→ 行为与以前**逐字节一致**。
 *
 * 失败分类的判据与文案在 `tools/failures.cjs`（FailureCode 的唯一来源）：
 * 主循环据此决定「提示什么、能不能原样重试、要不要用户介入」，不再对全部失败回灌同一句话。
 */
'use strict';

const { describeFailure } = require('./failures.cjs');

class AgentToolResult {
  /**
   * @param {boolean} ok
   * @param {string} text
   * @param {any} [data]
   * @param {{kind?: 'success'|'partial'|'failure', failure?: any, failed?: any[], modelContent?: string|null}} [options]
   */
  constructor(ok, text, data, options) {
    const o = options || {};
    this.ok = !!ok;
    this.text = text || '';
    this.data = data || {};
    /** @type {'success'|'partial'|'failure'} 判别联合的 kind（S5） */
    this.kind = o.kind || (this.ok ? 'success' : 'failure');
    /** @type {any} 失败分类（code/category/retryable/userActionRequired/hint…）；非失败时为 null */
    this.failure = o.failure || null;
    /** @type {Array<any>|null} partial 时逐单元失败明细 [{unit, failure}] */
    this.failed = Array.isArray(o.failed) ? o.failed : null;
    /**
     * 模型可见投影（A1）。`null` = 没提供 → 走旧口径（`text` + `[data]` JSON）。
     * 空字符串是**合法值**（语义是「这次工具结果不需要给模型看任何东西」）→ 用 null 判断，不用 falsy。
     * @type {string|null}
     */
    this.modelContent = o.modelContent == null ? null : String(o.modelContent);
  }

  toJSON() {
    return {
      ok: this.ok,
      text: this.text,
      data: this.data,
      kind: this.kind,
      failure: this.failure,
      failed: this.failed,
      modelContent: this.modelContent,
    };
  }

  static ok(text, data, options) {
    return new AgentToolResult(true, text, data, options);
  }

  static error(text, data, options) {
    return new AgentToolResult(false, text, data, options);
  }

  /**
   * 显式声明失败码（推荐新代码使用）。会同时把 code 写进 `data.code`，与既有的
   * `data.code` 读取方（UI / 测试 / 主循环）保持兼容。
   * @param {string} code FailureCode 或已登记的 legacy code
   * @param {string} message
   * @param {any} [data]
   * @param {{retryable?: boolean, userActionRequired?: boolean, tool?: string, detail?: any, modelContent?: string|null}} [extra]
   */
  static failure(code, message, data, extra) {
    const failure = describeFailure(code, message, extra);
    const payload = Object.assign({}, data || {}, { code: failure.code, failureCode: failure.code });
    return new AgentToolResult(false, message || failure.hint || '', payload, {
      kind: 'failure',
      failure,
      // A1：失败结果一般**不**做投影（`[data]` 里的 code/retryable/userActionRequired 是判据），
      // 只有工具显式给了才用 —— 缺省 null = 与旧行为逐字节一致。
      modelContent: extra && extra.modelContent,
    });
  }

  /**
   * 部分成功：主体结果可用，但其中若干单元失败（例如批量编辑里部分文件写失败）。
   * `ok` 为 true（主结果可用），失败明细在 `failed` 与 `data.partialFailures` 里。
   * @param {string} text
   * @param {any} [data]
   * @param {Array<{unit: string, failure: any}>} [failed]
   * @param {{modelContent?: string|null}} [options]
   */
  static partial(text, data, failed, options) {
    const list = Array.isArray(failed) ? failed : [];
    const payload = Object.assign({}, data || {}, { partialFailures: list.map((item) => ({ unit: item && item.unit, code: item && item.failure && item.failure.code })) });
    return new AgentToolResult(true, text, payload, { kind: 'partial', failed: list, modelContent: options && options.modelContent });
  }
}

module.exports = { AgentToolResult };
