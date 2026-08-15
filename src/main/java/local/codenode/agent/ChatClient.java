package local.codenode.agent;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 模型客户端抽象：OpenAI 兼容 chat.completions 的流式调用。
 *
 * <p>生产实现为 {@link OpenAiChatClient}；测试/评估可注入脚本化实现
 * （如 {@code AgentEvalSuite} 的 ScriptedChatClient），使 harness 行为
 * 可以在无网络、确定性条件下验证。</p>
 */
public interface ChatClient {

    /**
     * 发送流式请求并推送事件；返回最终 assistant 消息（含 tool_calls）供历史追加。
     *
     * @throws IOException           网络/HTTP/配置错误
     * @throws InterruptedException  用户停止
     */
    Map<String, Object> chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools,
                             Consumer<ChatEvent> events) throws IOException, InterruptedException;

    /** 最近一次请求的 token 用量（读后清除）；不支持时返回 null（trace 用）。 */
    default Map<String, Object> lastUsage() {
        return null;
    }

    /** 中止当前请求（停止按钮调用）；无活动请求时无操作。 */
    default void abort() {
    }
}
