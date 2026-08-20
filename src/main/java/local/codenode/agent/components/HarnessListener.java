package local.codenode.agent.components;

import local.codenode.agent.tools.AgentToolContext;

import java.util.Map;

/**
 * harness 事件监听组件（对应 DeepSeek Harness 的 hooks / 可观测性插件）。
 *
 * <p>会话生命周期事件：{@code beginSession}（新会话开始，携带 sessionId）、
 * {@code endSession}（会话结束）、{@code onEvent(type, fields)}（llm_call /
 * tool_call / retry_nudge / plan_check / error / session_start / session_end
 * 等事件类型）。监听器列表由 {@code harness.listeners} 配置选择，内置
 * {@code trace}（持久化 JSONL trace）。</p>
 */
public interface HarnessListener {

    /** 配置里引用的监听器名（如 {@code trace}）。 */
    String name();

    /** 新会话开始（每轮 sendMessage 一次；实现可在此重建 per-session 资源）。 */
    default void beginSession(String sessionId) {
    }

    /** 会话结束（无论成功/取消/异常都会调用；实现在此释放资源）。 */
    default void endSession() {
    }

    /** 事件广播（类型见类注释；fields 为结构化字段）。 */
    default void onEvent(String type, Map<String, Object> fields) {
    }

    /** 监听器工厂。 */
    @FunctionalInterface
    interface Factory {
        HarnessListener create(AgentToolContext toolContext);
    }
}
