/**
 * 并发请求登记表（#7：前端并发/竞态发送）。
 *
 * 背景：修复前 `chatStore` 用**单值** `sending: boolean` + `requestId: string | null` 表达
 * 「有一个请求在跑」。`RunsPanel` 的「自动续跑 / 按当前状态重试」绕过输入框的 `busy` 守卫直接
 * `sendChat`，于是第二次 `send` 会把 `requestId` 覆盖掉 —— 旧请求的 controller 再也点不到
 * （停止按钮失效、旧 Run 继续真实调用工具），而两条请求的增量都会追加到「最后一条 assistant」上，
 * 交错进同一个气泡。
 *
 * 修法：把「谁在跑」改成**按 requestId 索引的集合**，`sending` 变为派生值（`size > 0`）。
 * 这个模块只做登记/注销/精确停止这三件事，是纯逻辑（无 React、无 zustand），
 * 因此可以在 node 里直接断言 —— 变异测试也才有判据可打。
 */

export interface AbortLike {
  abort: () => void;
}

export interface InflightEntry<T> {
  controller: T;
  label?: string;
}

export interface InflightRegistry<T> {
  /** 登记一个新请求；同一 id 重复登记会被拒绝（返回 false），避免覆盖旧 controller */
  begin: (id: string, controller: T, label?: string) => boolean;
  /** 只清理自己那一条（`finally` 用）——绝不能顺手把别人的清掉 */
  end: (id: string) => boolean;
  has: (id: string) => boolean;
  /** 精确停止：只中止指定请求 */
  abort: (id: string) => boolean;
  /** 「全部停止」出口：中止并清空所有在跑请求 */
  abortAll: () => string[];
  ids: () => string[];
  size: () => number;
  /** 派生值：有请求在跑（替代修复前的单值 `sending: boolean`） */
  isSending: () => boolean;
}

export function createInflightRegistry<T extends AbortLike>(): InflightRegistry<T> {
  // 模块级/实例级 Map：键是 requestId，值是那一条请求自己的 controller。
  // 「集合」而不是「单值」正是这条修复的核心。
  const entries = new Map<string, InflightEntry<T>>();

  return {
    begin(id, controller, label) {
      if (!id || entries.has(id)) return false;
      entries.set(id, { controller, label });
      return true;
    },
    end(id) {
      return entries.delete(id);
    },
    has(id) {
      return entries.has(id);
    },
    abort(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      entries.delete(id);
      entry.controller.abort();
      return true;
    },
    abortAll() {
      const ids = [...entries.keys()];
      for (const id of ids) {
        const entry = entries.get(id);
        entries.delete(id);
        if (entry) entry.controller.abort();
      }
      return ids;
    },
    ids() {
      return [...entries.keys()];
    },
    size() {
      return entries.size;
    },
    isSending() {
      return entries.size > 0;
    },
  };
}
