package local.codenode.agent;

import java.io.IOException;

/**
 * 带 HTTP 状态码的模型 API 调用异常。
 *
 * <p>statusCode 语义：{@code >=100} 为 HTTP 响应状态码；{@code 0} 表示配置类错误
 * （如未配置 API），重试无意义。429（限流）与 5xx（服务端错误）由
 * {@link RetryingChatClient} 做指数退避重试。</p>
 */
public final class ChatHttpException extends IOException {
    private final int statusCode;

    public ChatHttpException(int statusCode, String message) {
        super(message);
        this.statusCode = statusCode;
    }

    public int statusCode() {
        return statusCode;
    }

    /** 是否值得重试：HTTP 429（限流）或 5xx（服务端错误）。4xx 与配置类错误（0）不重试。 */
    public boolean retryable() {
        return statusCode == 429 || statusCode >= 500;
    }
}
