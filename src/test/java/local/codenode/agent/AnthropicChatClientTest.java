package local.codenode.agent;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import local.codenode.Json;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Anthropic Messages API 适配：本地 HttpServer 模拟对端，验证
 * 请求体转换（system 提取、tool_calls→tool_use、tool→tool_result、input_schema）、
 * SSE 流解析（text/thinking/tool_use）、usage 转换与错误映射。
 */
class AnthropicChatClientTest {

    private HttpServer server;
    private AgentConfig config;
    private final List<String> requestBodies = new ArrayList<>();
    private final AtomicReference<Map<String, String>> lastHeaders = new AtomicReference<>();
    private String responseBody = "";
    private int responseStatus = 200;

    @TempDir
    Path tempDir;

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/messages", this::handle);
        server.start();
        config = new AgentConfig(tempDir.resolve("agent.properties"));
        config.setApiBase("http://127.0.0.1:" + server.getAddress().getPort());
        config.setApiKey("test-key");
        config.setModel("claude-sonnet-4-5");
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private void handle(HttpExchange exchange) throws IOException {
        requestBodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        Map<String, String> headers = new LinkedHashMap<>();
        exchange.getRequestHeaders().forEach((k, v) -> headers.put(k, String.join(",", v)));
        lastHeaders.set(headers);
        byte[] bytes = responseBody.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        // 注意：用固定 Content-Length 而非 chunked（-1）——HttpURLConnection 对
        // 本机 HttpServer 的 chunked 流式响应读不到数据（生产 API 无此问题）
        exchange.sendResponseHeaders(responseStatus, bytes.length);
        try (var out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static String sse(String eventType, String data) {
        return "event: " + eventType + "\ndata: " + data + "\n\n";
    }

    private AnthropicChatClient client() {
        return new AnthropicChatClient(config);
    }

    private static List<ChatEvent> collect(AnthropicChatClient client,
                                           List<Map<String, Object>> messages, List<Map<String, Object>> tools)
            throws Exception {
        List<ChatEvent> events = new ArrayList<>();
        client.chat(messages, tools, events::add);
        return events;
    }

    // ---------- SSE 解析 ----------

    @Test
    void parsesTextStreamAndUsage() throws Exception {
        responseBody = sse("message_start", "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}")
                + sse("content_block_start", "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}")
                + sse("content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}")
                + sse("content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"世界\"}}")
                + sse("content_block_stop", "{\"type\":\"content_block_stop\",\"index\":0}")
                + sse("message_delta", "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}")
                + sse("message_stop", "{\"type\":\"message_stop\"}");

        AnthropicChatClient client = client();
        List<ChatEvent> events = collect(client, List.of(Map.of("role", "user", "content", "hi")), null);
        Map<String, Object> usage = client.lastUsage();
        assertEquals(10L, usage.get("prompt_tokens"));
        assertEquals(5L, usage.get("completion_tokens"));
        StringBuilder streamed = new StringBuilder();
        events.forEach(e -> { if (e.kind() == ChatEventKind.STREAM) streamed.append(e.text()); });
        assertEquals("你好世界", streamed.toString());
    }

    @Test
    void parsesThinkingDeltaAsReasoning() throws Exception {
        responseBody = sse("message_start", "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}")
                + sse("content_block_start", "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}")
                + sse("content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"先分析\"}}")
                + sse("content_block_stop", "{\"type\":\"content_block_stop\",\"index\":0}")
                + sse("message_stop", "{\"type\":\"message_stop\"}");

        List<ChatEvent> events = collect(client(), List.of(Map.of("role", "user", "content", "hi")), null);
        StringBuilder reasoning = new StringBuilder();
        events.forEach(e -> { if (e.kind() == ChatEventKind.REASONING) reasoning.append(e.text()); });
        assertEquals("先分析", reasoning.toString());
    }

    @Test
    void parsesToolUseStream() throws Exception {
        responseBody = sse("message_start", "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":20,\"output_tokens\":1}}}")
                + sse("content_block_start", "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"run_project\",\"input\":{}}}")
                + sse("content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"project\\\":\\\"demo\\\"}\"}}")
                + sse("content_block_stop", "{\"type\":\"content_block_stop\",\"index\":0}")
                + sse("message_delta", "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}")
                + sse("message_stop", "{\"type\":\"message_stop\"}");

        List<ChatEvent> events = collect(client(), List.of(Map.of("role", "user", "content", "跑一下")), null);
        List<AgentToolCall> toolCalls = events.stream().filter(e -> e.kind() == ChatEventKind.TOOL_CALL)
                .map(ChatEvent::toolCall).toList();
        assertEquals(1, toolCalls.size());
        assertEquals("toolu_01", toolCalls.get(0).callId());
        assertEquals("run_project", toolCalls.get(0).name());
        assertEquals("demo", toolCalls.get(0).arguments().get("project"));
    }

    // ---------- 请求体转换 ----------

    @SuppressWarnings("unchecked")
    @Test
    void convertsOpenAiMessagesAndTools() throws Exception {
        responseBody = sse("message_start", "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}")
                + sse("message_stop", "{\"type\":\"message_stop\"}");

        List<Map<String, Object>> messages = new ArrayList<>();
        messages.add(Map.of("role", "system", "content", "你是 CodeNode 助手"));
        messages.add(Map.of("role", "user", "content", "运行项目"));
        Map<String, Object> assistant = new LinkedHashMap<>();
        assistant.put("role", "assistant");
        assistant.put("content", "");
        Map<String, Object> fn = new LinkedHashMap<>();
        fn.put("name", "run_project");
        fn.put("arguments", "{\"project\":\"demo\"}");
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("id", "call_1");
        call.put("type", "function");
        call.put("function", fn);
        assistant.put("tool_calls", List.of(call));
        messages.add(assistant);
        Map<String, Object> toolMsg = new LinkedHashMap<>();
        toolMsg.put("role", "tool");
        toolMsg.put("tool_call_id", "call_1");
        toolMsg.put("content", "构建成功");
        messages.add(toolMsg);

        Map<String, Object> toolFn = new LinkedHashMap<>();
        toolFn.put("name", "run_project");
        toolFn.put("description", "运行项目");
        toolFn.put("parameters", Map.of("type", "object", "properties", Map.of("project", Map.of("type", "string"))));
        Map<String, Object> tool = new LinkedHashMap<>();
        tool.put("type", "function");
        tool.put("function", toolFn);

        collect(client(), messages, List.of(tool));

        Map<String, Object> body = Json.object(requestBodies.get(0));
        assertEquals("claude-sonnet-4-5", body.get("model"));
        assertEquals(8192L, body.get("max_tokens"));
        assertEquals(true, body.get("stream"));
        assertEquals("你是 CodeNode 助手", body.get("system"));

        List<?> converted = (List<?>) body.get("messages");
        assertEquals(3, converted.size());
        assertEquals("user", ((Map<?, ?>) converted.get(0)).get("role"));
        assertEquals("运行项目", ((Map<?, ?>) converted.get(0)).get("content"));

        Map<?, ?> assistantMsg = (Map<?, ?>) converted.get(1);
        assertEquals("assistant", assistantMsg.get("role"));
        List<?> assistantBlocks = (List<?>) assistantMsg.get("content");
        Map<?, ?> toolUse = (Map<?, ?>) assistantBlocks.get(0);
        assertEquals("tool_use", toolUse.get("type"));
        assertEquals("call_1", toolUse.get("id"));
        assertEquals("run_project", toolUse.get("name"));
        assertEquals("demo", ((Map<?, ?>) toolUse.get("input")).get("project"));

        Map<?, ?> toolResultMsg = (Map<?, ?>) converted.get(2);
        assertEquals("user", toolResultMsg.get("role"));
        Map<?, ?> toolResult = (Map<?, ?>) ((List<?>) toolResultMsg.get("content")).get(0);
        assertEquals("tool_result", toolResult.get("type"));
        assertEquals("call_1", toolResult.get("tool_use_id"));
        assertEquals("构建成功", toolResult.get("content"));

        List<?> convertedTools = (List<?>) body.get("tools");
        Map<?, ?> convertedTool = (Map<?, ?>) convertedTools.get(0);
        assertEquals("run_project", convertedTool.get("name"));
        assertEquals("object", ((Map<?, ?>) convertedTool.get("input_schema")).get("type"));
        assertNotNull(convertedTool.get("description"));
    }

    @Test
    void sendsAnthropicHeaders() throws Exception {
        responseBody = sse("message_start", "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}")
                + sse("message_stop", "{\"type\":\"message_stop\"}");
        collect(client(), List.of(Map.of("role", "user", "content", "hi")), null);
        Map<String, String> headers = lastHeaders.get();
        String apiKeyHeader = headers.entrySet().stream()
                .filter(e -> e.getKey().equalsIgnoreCase("x-api-key"))
                .map(Map.Entry::getValue).findFirst().orElse(null);
        String versionHeader = headers.entrySet().stream()
                .filter(e -> e.getKey().equalsIgnoreCase("anthropic-version"))
                .map(Map.Entry::getValue).findFirst().orElse(null);
        assertEquals("test-key", apiKeyHeader);
        assertEquals("2023-06-01", versionHeader);
    }

    @Test
    void prependsUserMessageWhenHistoryStartsWithAssistant() throws Exception {
        responseBody = sse("message_start", "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}")
                + sse("message_stop", "{\"type\":\"message_stop\"}");
        collect(client(), List.of(Map.of("role", "assistant", "content", "继续")), null);
        Map<String, Object> body = Json.object(requestBodies.get(0));
        List<?> messages = (List<?>) body.get("messages");
        assertEquals("user", ((Map<?, ?>) messages.get(0)).get("role"));
        assertEquals(2, messages.size());
    }

    // ---------- 错误与端点 ----------

    @Test
    void non200ThrowsChatHttpExceptionWithStatus() {
        responseStatus = 429;
        ChatHttpException e = assertThrows(ChatHttpException.class,
                () -> collect(client(), List.of(Map.of("role", "user", "content", "hi")), null));
        assertEquals(429, e.statusCode());
        assertTrue(e.retryable());
    }

    @Test
    void sseErrorMapsRateLimitTo429() {
        responseBody = sse("error", "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"速率超限\"}}");
        ChatHttpException e = assertThrows(ChatHttpException.class,
                () -> collect(client(), List.of(Map.of("role", "user", "content", "hi")), null));
        assertEquals(429, e.statusCode());
        assertTrue(e.getMessage().contains("速率超限"));
    }

    @Test
    void notConfiguredThrowsConfigError() {
        AgentConfig empty = new AgentConfig(tempDir.resolve("empty.properties"));
        AnthropicChatClient client = new AnthropicChatClient(empty);
        ChatHttpException e = assertThrows(ChatHttpException.class,
                () -> collect(client, List.of(Map.of("role", "user", "content", "hi")), null));
        assertEquals(0, e.statusCode());
    }

    @Test
    void endpointAppendsV1Messages() {
        AgentConfig withoutV1 = new AgentConfig(tempDir.resolve("a.properties"));
        withoutV1.setApiBase("https://api.anthropic.com");
        assertEquals("https://api.anthropic.com/v1/messages", new AnthropicChatClient(withoutV1).endpoint());

        AgentConfig withV1 = new AgentConfig(tempDir.resolve("b.properties"));
        withV1.setApiBase("https://api.anthropic.com/v1/");
        assertEquals("https://api.anthropic.com/v1/messages", new AnthropicChatClient(withV1).endpoint());

        AgentConfig blank = new AgentConfig(tempDir.resolve("c.properties"));
        assertEquals("https://api.anthropic.com/v1/messages", new AnthropicChatClient(blank).endpoint());
    }
}
