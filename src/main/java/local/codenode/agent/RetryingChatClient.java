package local.codenode.agent;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Consumer;

/**
 * {@link ChatClient} 装饰器：对可重试故障做指数退避 + 抖动重试。
 *
 * <p>可重试：网络层 {@link IOException}（非 HTTP 响应）、HTTP 429/5xx
 * （{@link ChatHttpException#retryable()}）。不重试：4xx 客户端错误（配置/鉴权问题）、
 * 配置类错误（statusCode 0）、{@link InterruptedException}（用户停止）。</p>
 *
 * <p>退避延迟 = min(maxDelay, baseDelay * 2^attempt) + 0~30% 抖动；
 * 每次重试前推送 {@link ChatEvent#system} 提示并检查中断标志，
 * {@link Thread#sleep(long)} 可中断，停止按钮可立即打断。</p>
 */
public final class RetryingChatClient implements ChatClient {
    /** 默认最大重试次数（不含首次尝试）。 */
    public static final int DEFAULT_MAX_RETRIES = 3;
    /** 默认基础退避延迟（毫秒）。 */
    public static final long DEFAULT_BASE_DELAY_MS = 1_000;
    /** 默认最大退避延迟（毫秒）。 */
    public static final long DEFAULT_MAX_DELAY_MS = 15_000;

    private final ChatClient delegate;
    private final int maxRetries;
    private final long baseDelayMs;
    private final long maxDelayMs;

    public RetryingChatClient(ChatClient delegate) {
        this(delegate, DEFAULT_MAX_RETRIES, DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS);
    }

    /** 测试构造：可注入更小的重试次数与退避基数。 */
    public RetryingChatClient(ChatClient delegate, int maxRetries, long baseDelayMs, long maxDelayMs) {
        this.delegate = delegate;
        this.maxRetries = Math.max(0, maxRetries);
        this.baseDelayMs = Math.max(50, baseDelayMs);
        this.maxDelayMs = Math.max(this.baseDelayMs, maxDelayMs);
    }

    @Override
    public Map<String, Object> chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools,
                                    Consumer<ChatEvent> events) throws IOException, InterruptedException {
        int attempt = 0;
        while (true) {
            try {
                return delegate.chat(messages, tools, events);
            } catch (InterruptedException e) {
                throw e;
            } catch (IOException e) {
                if (attempt >= maxRetries || !retryable(e)) throw e;
                long delay = backoffDelay(attempt);
                attempt++;
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException("已停止");
                events.accept(ChatEvent.system("（API 调用失败：" + brief(e) + "，" + delay + "ms 后自动重试）"));
                Thread.sleep(delay);
            }
        }
    }

    @Override
    public Map<String, Object> lastUsage() {
        return delegate.lastUsage();
    }

    @Override
    public void abort() {
        delegate.abort();
    }

    /** 裸 IOException（网络层）可重试；ChatHttpException 按状态码判定。 */
    private static boolean retryable(IOException e) {
        return !(e instanceof ChatHttpException http) || http.retryable();
    }

    private long backoffDelay(int attempt) {
        long exponential = baseDelayMs << Math.min(attempt, 5); // 防溢出
        long delay = Math.min(maxDelayMs, exponential);
        double jitter = ThreadLocalRandom.current().nextDouble(0, 0.3);
        return Math.max(1, (long) (delay * (1 + jitter)));
    }

    private static String brief(IOException e) {
        String message = e.getMessage();
        return message == null || message.isBlank() ? e.getClass().getSimpleName()
                : message.length() > 120 ? message.substring(0, 120) + "…" : message;
    }
}
