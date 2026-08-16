package local.codenode.agent;

/**
 * 会话历史压缩摘要策略（P1-9a）：本地规则版（{@code TextSummarizer}）与可选 LLM 版
 * （{@link LlmConversationSummarizer}）的统一抽象。返回 null/空白表示失败，
 * 由 {@link MessageHistory} 回退到本地摘要。
 */
@FunctionalInterface
public interface ConversationSummarizer {

    /** 将压缩源文本（早期会话消息拼接）压缩为一段摘要；失败返回 null。 */
    String summarize(String source);
}
