package local.codenode.agent;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 重试退避装饰器：429/5xx/网络错误指数退避重试；4xx/配置错误/中断不重试；
 * 退避延迟随次数递增；abort/lastUsage 转发。
 */
class RetryingChatClientTest {

    /** 可编程 fake client：前 N 次调用抛预设异常，之后成功。 */
    private static final class FakeChatClient implements ChatClient {
        final List<IOException> failures = new ArrayList<>();
        final List<Long> callTimes = new ArrayList<>();
        final List<Consumer<ChatEvent>> eventConsumers = new ArrayList<>();
        int calls;
        boolean aborted;

        @Override
        public Map<String, Object> chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools,
                                        Consumer<ChatEvent> events) throws IOException, InterruptedException {
            calls++;
            callTimes.add(System.nanoTime());
            eventConsumers.add(events);
            if (calls <= failures.size()) throw failures.get(calls - 1);
            return Map.of("role", "assistant", "content", "ok");
        }

        @Override
        public Map<String, Object> lastUsage() {
            return Map.of("prompt_tokens", 7);
        }

        @Override
        public void abort() {
            aborted = true;
        }
    }

    private static ChatHttpException http(int status) {
        return new ChatHttpException(status, "API 返回 " + status);
    }

    private static RetryingChatClient retrying(FakeChatClient fake, int maxRetries, long baseDelayMs) {
        return new RetryingChatClient(fake, maxRetries, baseDelayMs, 500);
    }

    @Test
    void retriesOn429ThenSucceeds() throws Exception {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(http(429));
        fake.failures.add(http(429));
        Map<String, Object> result = retrying(fake, 3, 50).chat(List.of(), null, events -> {});
        assertEquals("ok", result.get("content"));
        assertEquals(3, fake.calls);
    }

    @Test
    void retriesOn5xxThenSucceeds() throws Exception {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(http(500));
        fake.failures.add(http(502));
        Map<String, Object> result = retrying(fake, 3, 50).chat(List.of(), null, events -> {});
        assertEquals("ok", result.get("content"));
        assertEquals(3, fake.calls);
    }

    @Test
    void givesUpAfterMaxRetries() {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(http(500));
        fake.failures.add(http(500));
        fake.failures.add(http(500));
        fake.failures.add(http(500)); // 第 4 次调用仍失败
        ChatHttpException e = assertThrows(ChatHttpException.class,
                () -> retrying(fake, 3, 50).chat(List.of(), null, events -> {}));
        assertEquals(500, e.statusCode());
        assertEquals(4, fake.calls); // 首次 + 3 次重试
    }

    @Test
    void noRetryOnClientError() {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(http(400));
        ChatHttpException e = assertThrows(ChatHttpException.class,
                () -> retrying(fake, 3, 50).chat(List.of(), null, events -> {}));
        assertEquals(400, e.statusCode());
        assertEquals(1, fake.calls);
    }

    @Test
    void noRetryOnConfigError() {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(new ChatHttpException(0, "未配置 Agent API"));
        ChatHttpException e = assertThrows(ChatHttpException.class,
                () -> retrying(fake, 3, 50).chat(List.of(), null, events -> {}));
        assertEquals(0, e.statusCode());
        assertEquals(1, fake.calls);
    }

    @Test
    void retriesOnNetworkError() throws Exception {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(new IOException("Connection reset"));
        fake.failures.add(new IOException("Connection reset"));
        Map<String, Object> result = retrying(fake, 3, 50).chat(List.of(), null, events -> {});
        assertEquals("ok", result.get("content"));
        assertEquals(3, fake.calls);
    }

    @Test
    void backoffDelayIncreasesWithAttempts() throws Exception {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(http(429));
        fake.failures.add(http(429));
        fake.failures.add(http(429));
        retrying(fake, 3, 50).chat(List.of(), null, events -> {});
        assertEquals(4, fake.calls);
        long first = ms(fake.callTimes.get(1) - fake.callTimes.get(0));
        long second = ms(fake.callTimes.get(2) - fake.callTimes.get(1));
        long third = ms(fake.callTimes.get(3) - fake.callTimes.get(2));
        // 指数退避：50ms → 100ms → 200ms（+抖动只增不减），下限断言防计时抖动
        assertTrue(first >= 50, "首次退避应 >= 50ms，实际 " + first);
        assertTrue(second >= 100, "第二次退避应 >= 100ms，实际 " + second);
        assertTrue(third >= 200, "第三次退避应 >= 200ms，实际 " + third);
        assertTrue(second > first && third > second, "退避应递增");
    }

    @Test
    void interruptionDuringBackoffIsPropagated() {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(new IOException("Connection reset"));
        Thread.currentThread().interrupt();
        try {
            // 网络错误 → 进入退避等待 → 线程已中断 → Thread.sleep 立即抛 InterruptedException 并传播
            assertThrows(InterruptedException.class,
                    () -> retrying(fake, 3, 1_000).chat(List.of(), null, events -> {}));
        } finally {
            Thread.interrupted(); // 清理中断标志，避免污染后续测试
        }
        assertEquals(1, fake.calls);
    }

    @Test
    void forwardsAbortAndUsage() throws Exception {
        FakeChatClient fake = new FakeChatClient();
        RetryingChatClient client = retrying(fake, 1, 50);
        client.abort();
        assertTrue(fake.aborted);
        assertEquals(7, client.lastUsage().get("prompt_tokens"));
    }

    @Test
    void pushesSystemEventBeforeRetry() throws Exception {
        FakeChatClient fake = new FakeChatClient();
        fake.failures.add(http(429));
        List<ChatEvent> events = new ArrayList<>();
        retrying(fake, 2, 50).chat(List.of(), null, events::add);
        ChatEvent system = events.stream().filter(e -> e.kind() == ChatEventKind.SYSTEM).findFirst().orElse(null);
        assertTrue(system != null && system.text().contains("自动重试"), "重试前应推送系统提示：" + events);
    }

    private static long ms(long nanos) {
        return nanos / 1_000_000;
    }
}
