package local.codenode.agent;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** LlmConversationSummarizer：LLM 会话摘要成功/失败回退路径（P1-9a）。 */
class LlmConversationSummarizerTest {

    private static final class FakeClient implements ChatClient {
        private final Map<String, Object> response;
        private final IOException failure;

        FakeClient(Map<String, Object> response) {
            this.response = response;
            this.failure = null;
        }

        FakeClient(IOException failure) {
            this.response = null;
            this.failure = failure;
        }

        @Override
        public Map<String, Object> chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools,
                                        Consumer<ChatEvent> events) throws IOException {
            if (failure != null) throw failure;
            return response;
        }
    }

    @Test
    void returnsContentWhenModelAnswers() {
        LlmConversationSummarizer summarizer = new LlmConversationSummarizer(
                new FakeClient(Map.of("role", "assistant", "content", "目标：扫描项目；已完成：scan_project；结论：结构清晰")));
        String result = summarizer.summarize("user: 扫描项目\nassistant: 好的");
        assertTrue(result != null && result.contains("扫描项目"), "应返回模型正文：" + result);
    }

    @Test
    void fallsBackToReasoningWhenContentEmpty() {
        LlmConversationSummarizer summarizer = new LlmConversationSummarizer(
                new FakeClient(Map.of("role", "assistant", "reasoning", "（推理）已完成三步骤", "content", "")));
        String result = summarizer.summarize("user: 任务");
        assertTrue(result != null && result.contains("已完成三步骤"), "正文为空时应回退推理：" + result);
    }

    @Test
    void returnsNullOnFailureForLocalFallback() {
        LlmConversationSummarizer summarizer = new LlmConversationSummarizer(
                new FakeClient(new IOException("network down")));
        assertNull(summarizer.summarize("user: 任务"), "网络失败应返回 null 触发本地回退");
    }

    @Test
    void ignoresBlankSource() {
        LlmConversationSummarizer summarizer = new LlmConversationSummarizer(new FakeClient(Map.of()));
        assertNull(summarizer.summarize("   "));
    }

    @Test
    void truncatesOversizedSource() {
        LlmConversationSummarizer summarizer = new LlmConversationSummarizer(
                new FakeClient(Map.of("role", "assistant", "content", "ok")));
        String result = summarizer.summarize("a".repeat(100_000));
        assertEquals("ok", result, "超长源应截断后仍可摘要");
    }
}
