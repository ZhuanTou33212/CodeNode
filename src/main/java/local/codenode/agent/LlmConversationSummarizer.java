package local.codenode.agent;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * 基于现有 ChatClient 的 LLM 会话摘要（P1-9a）：把早期会话消息压缩为结构化摘要，
 * 替代本地规则版 {@code TextSummarizer} 的信息损失。
 *
 * <p>失败（网络/协议异常、空输出）返回 null，由 {@link MessageHistory} 回退本地摘要，
 * 摘要失败不阻断会话。启用开关：{@code agent.properties} 的 {@code harness.llm_summary=true}。</p>
 */
public final class LlmConversationSummarizer implements ConversationSummarizer {
    private static final int MAX_SOURCE_CHARS = 40_000;

    private final ChatClient client;

    public LlmConversationSummarizer(ChatClient client) {
        this.client = client;
    }

    @Override
    public String summarize(String source) {
        if (source == null || source.isBlank()) return null;
        String trimmed = source.length() > MAX_SOURCE_CHARS ? source.substring(0, MAX_SOURCE_CHARS) + "\n…（超长截断）" : source;
        String prompt = "你在执行一次「上下文交接压缩」（Codex 式 CONTEXT CHECKPOINT COMPACTION）。请把下面这段 agent 会话记录压缩为一份交接摘要，供另一个模型继续完成同一任务。必须覆盖：①当前进度与关键决策；②重要上下文/约束/偏好；③尚未完成的事项；④关键数据、示例与文件/节点/工具引用。要求简洁、结构化（分点列出），不要编造记录中没有的信息，不要保留对话寒暄。\n\n"
                + "会话记录：\n" + trimmed;
        try {
            StringBuilder out = new StringBuilder();
            Map<String, Object> assistant = client.chat(
                    List.of(Map.of("role", "user", "content", prompt)), null, event -> {
                        // 摘要无需流式事件
                    });
            Object content = assistant == null ? null : assistant.get("content");
            if (content instanceof String text && !text.isBlank()) {
                out.append(text.trim());
            }
            // 模型只给推理没给正文时兜底
            if (out.isEmpty() && assistant != null && assistant.get("reasoning") instanceof String reasoning && !reasoning.isBlank()) {
                out.append(reasoning.trim());
            }
            return out.isEmpty() ? null : out.toString();
        } catch (IOException | InterruptedException e) {
            return null; // 失败回退本地摘要
        }
    }
}
