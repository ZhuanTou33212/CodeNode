package local.codenode.agent;

import java.util.Map;

/**
 * 会话级 token 预算：累加每次 LLM 调用的 usage（prompt + completion），
 * 超限后由 {@code AgentChatController} 停止工具循环并强制收尾，
 * 防止失控循环/长任务消耗超出预期的调用量。
 *
 * <p>挂在 {@link AgentSessionScope} 上，随对话 tab 隔离；{@code limit=0} 表示不限。</p>
 */
public final class TokenBudget {
    private volatile long limit = 0;
    private long used = 0;

    /** 设置上限（0 = 不限）。 */
    public void setLimit(long limit) {
        this.limit = Math.max(0, limit);
    }

    public long limit() {
        return limit;
    }

    public synchronized long used() {
        return used;
    }

    public synchronized long remaining() {
        return limit <= 0 ? Long.MAX_VALUE : Math.max(0, limit - used);
    }

    /** 累加一次调用的 usage（OpenAI 风格键 prompt_tokens / completion_tokens；Anthropic 已转换）。 */
    public synchronized void record(Map<String, Object> usage) {
        if (usage == null) return;
        long prompt = asLong(usage.get("prompt_tokens"));
        long completion = asLong(usage.get("completion_tokens"));
        used += prompt + completion;
    }

    public synchronized void reset() {
        used = 0;
    }

    /** 是否已超限（limit=0 永不为 true）。 */
    public boolean exceeded() {
        return limit > 0 && used >= limit;
    }

    private static long asLong(Object value) {
        if (value instanceof Number n) return n.longValue();
        if (value instanceof String s) {
            try {
                return Long.parseLong(s.trim());
            } catch (NumberFormatException ignored) {
                // 非数字 usage 字段忽略
            }
        }
        return 0;
    }
}
