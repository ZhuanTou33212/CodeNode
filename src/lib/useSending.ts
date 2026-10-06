/**
 * 「有没有请求在跑」的派生读法（#7）。
 *
 * 修复前它是一个**独立可变的状态字段** `chatStore.sending: boolean`：谁都能把它设成 false
 * （每个 `send` 的 `finally` 都无条件设一次），于是并发下它必然说谎。
 * 现在它不再是可写状态，而是从 `inflight` 登记表算出来：
 *   `sending === inflight.size() > 0`
 * 唯一能改变它的操作是「登记/注销某一个 requestId」。
 */
import { useChatStore } from '../store/chatStore';

export function useSending(): boolean {
  return useChatStore((s) => s.inflight.size() > 0);
}
