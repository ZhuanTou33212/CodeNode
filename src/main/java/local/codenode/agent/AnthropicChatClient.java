package local.codenode.agent;

import local.codenode.Json;
import local.codenode.config.AgentConfig;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Anthropic Messages API 流式客户端（SSE），实现 {@link ChatClient} 使 harness 无感知切换。
 *
 * <p>负责 OpenAI 格式 ⇄ Anthropic 格式转换：</p>
 * <ul>
 *   <li>role=system 消息 → 顶层 {@code system} 参数（Anthropic 的 system 不在 messages 里）；</li>
 *   <li>assistant 的 tool_calls → content 块 {@code tool_use}（reasoning 字段丢弃——Claude 不认无 signature 的 thinking 块）；</li>
 *   <li>role=tool 消息 → user 消息的 {@code tool_result} 块；</li>
 *   <li>工具 schema {@code function.parameters} → {@code input_schema}。</li>
 * </ul>
 *
 * <p>流式事件：message_start（usage）/ content_block_start（tool_use 的 id/name）/
 * content_block_delta（text_delta、thinking_delta、input_json_delta）/ error。
 * usage 转成 OpenAI 风格键（prompt_tokens/completion_tokens）供 trace 复用。
 * 非 200 与 SSE error 抛 {@link ChatHttpException}（429/5xx 可被 {@link RetryingChatClient} 重试）。</p>
 */
public final class AnthropicChatClient implements ChatClient {
    private static final String API_VERSION = "2023-06-01";
    private static final String DEFAULT_BASE = "https://api.anthropic.com";

    private final AgentConfig config;
    private volatile HttpURLConnection activeConnection;
    private volatile Map<String, Object> lastUsage;

    public AnthropicChatClient(AgentConfig config) {
        this.config = config;
    }

    @Override
    public Map<String, Object> lastUsage() {
        Map<String, Object> usage = lastUsage;
        lastUsage = null;
        return usage;
    }

    @Override
    public void abort() {
        HttpURLConnection connection = activeConnection;
        if (connection != null) {
            try { connection.disconnect(); } catch (Exception ignored) {}
        }
    }

    public boolean isConfigured() {
        return config.isConfigured();
    }

    /** /v1/messages 端点（baseUrl 已含 /v1 时不再重复拼接）。 */
    public String endpoint() {
        String base = config.apiBase();
        if (base.isBlank()) base = DEFAULT_BASE;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base.endsWith("/v1") ? base + "/messages" : base + "/v1/messages";
    }

    @Override
    public Map<String, Object> chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools,
                                    Consumer<ChatEvent> events) throws IOException, InterruptedException {
        if (!config.isConfigured()) {
            throw new ChatHttpException(0, "未配置 Agent API（请在“内嵌 Agent → 设置”填写 baseUrl / apiKey / model）");
        }
        AnthropicRequest converted = toAnthropicMessages(messages);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", config.model());
        body.put("max_tokens", config.maxTokens());
        body.put("stream", true);
        if (!converted.system().isEmpty()) body.put("system", converted.system());
        body.put("messages", converted.messages());
        if (tools != null && !tools.isEmpty()) body.put("tools", toAnthropicTools(tools));

        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint()).openConnection();
        activeConnection = connection;
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("x-api-key", config.apiKey());
            connection.setRequestProperty("anthropic-version", API_VERSION);
            connection.setDoOutput(true);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(120_000);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(Json.stringify(body).getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status != 200) {
                InputStream error = connection.getErrorStream();
                String detail = error == null ? "" : readAll(error);
                throw new ChatHttpException(status, "API 返回 " + status + (detail.isBlank() ? "" : "：" + detail.trim()));
            }
            return parseSse(connection.getInputStream(), events);
        } finally {
            activeConnection = null;
        }
    }

    /** OpenAI 消息列表 → Anthropic messages + system 参数。 */
    private static AnthropicRequest toAnthropicMessages(List<Map<String, Object>> openAi) {
        StringBuilder system = new StringBuilder();
        List<Map<String, Object>> messages = new ArrayList<>();
        for (Map<String, Object> msg : openAi) {
            String role = String.valueOf(msg.get("role"));
            switch (role) {
                case "system" -> {
                    Object content = msg.get("content");
                    if (content != null && !String.valueOf(content).isBlank()) {
                        if (system.length() > 0) system.append("\n\n");
                        system.append(content);
                    }
                }
                case "assistant" -> {
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("role", "assistant");
                    List<Object> blocks = new ArrayList<>();
                    if (msg.get("content") instanceof String text && !text.isBlank()) {
                        blocks.add(Map.of("type", "text", "text", text));
                    }
                    // reasoning 丢弃：Claude 不认无 signature 的 thinking 块
                    if (msg.get("tool_calls") instanceof List<?> calls) {
                        for (Object callObj : calls) {
                            if (!(callObj instanceof Map<?, ?> call)) continue;
                            String id = String.valueOf(call.get("id"));
                            String name = "";
                            Object input = Map.of();
                            if (call.get("function") instanceof Map<?, ?> function) {
                                name = String.valueOf(function.get("name"));
                                Object args = function.get("arguments");
                                if (args instanceof String s) {
                                    try { input = Json.parse(s); } catch (RuntimeException ignored) {}
                                } else if (args != null) {
                                    input = args;
                                }
                            }
                            Map<String, Object> block = new LinkedHashMap<>();
                            block.put("type", "tool_use");
                            block.put("id", id);
                            block.put("name", name);
                            block.put("input", input);
                            blocks.add(block);
                        }
                    }
                    if (blocks.isEmpty()) blocks.add(Map.of("type", "text", "text", ""));
                    out.put("content", blocks);
                    messages.add(out);
                }
                case "user", "tool" -> {
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("role", "user");
                    if ("tool".equals(role)) {
                        // tool 结果 → user 消息的 tool_result 块（tool_use_id 引用前文 tool_use）
                        Object content = msg.get("content");
                        List<Object> blocks = new ArrayList<>();
                        Map<String, Object> block = new LinkedHashMap<>();
                        block.put("type", "tool_result");
                        block.put("tool_use_id", String.valueOf(msg.get("tool_call_id")));
                        block.put("content", content == null ? "" : String.valueOf(content));
                        blocks.add(block);
                        out.put("content", blocks);
                    } else {
                        Object content = msg.get("content");
                        out.put("content", content == null ? "" : String.valueOf(content));
                    }
                    messages.add(out);
                }
                default -> { /* 未知角色（如 developer）跳过 */ }
            }
        }
        // Anthropic 约束：首条消息必须是 user；空历史兜底
        if (messages.isEmpty()) {
            messages.add(Map.of("role", "user", "content", ""));
        } else if ("assistant".equals(messages.get(0).get("role"))) {
            messages.add(0, Map.of("role", "user", "content", ""));
        }
        return new AnthropicRequest(system.toString(), messages);
    }

    /** OpenAI 工具列表（{type, function:{name,description,parameters}}）→ Anthropic（{name,description,input_schema}）。 */
    private static List<Map<String, Object>> toAnthropicTools(List<Map<String, Object>> tools) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map<String, Object> tool : tools) {
            if (!(tool.get("function") instanceof Map<?, ?> function)) continue;
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("name", String.valueOf(function.get("name")));
            if (function.get("description") != null && !String.valueOf(function.get("description")).isBlank()) {
                out.put("description", String.valueOf(function.get("description")));
            }
            Object parameters = function.get("parameters");
            out.put("input_schema", parameters instanceof Map<?, ?> schema ? schema : Map.of("type", "object"));
            result.add(out);
        }
        return result;
    }

    private Map<String, Object> parseSse(InputStream input, Consumer<ChatEvent> events) throws IOException, InterruptedException {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        Map<Integer, PendingToolUse> toolUses = new LinkedHashMap<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            String eventType = "";
            while ((line = reader.readLine()) != null) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException("已停止");
                if (line.startsWith("event:")) {
                    eventType = line.substring(6).trim();
                    continue;
                }
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if (data.isEmpty()) continue;
                Map<String, Object> event;
                try {
                    event = Json.object(data);
                } catch (RuntimeException ignored) {
                    continue;
                }
                switch (eventType) {
                    case "message_start" -> {
                        if (event.get("message") instanceof Map<?, ?> message
                                && message.get("usage") instanceof Map<?, ?> usage) {
                            Map<String, Object> converted = new LinkedHashMap<>();
                            converted.put("prompt_tokens", usage.get("input_tokens") == null ? 0 : usage.get("input_tokens"));
                            converted.put("completion_tokens", usage.get("output_tokens") == null ? 0 : usage.get("output_tokens"));
                            lastUsage = converted;
                        }
                    }
                    case "content_block_start" -> {
                        if (event.get("index") instanceof Number index
                                && event.get("content_block") instanceof Map<?, ?> block
                                && "tool_use".equals(String.valueOf(block.get("type")))) {
                            PendingToolUse pending = new PendingToolUse();
                            pending.id = String.valueOf(block.get("id"));
                            pending.name = String.valueOf(block.get("name"));
                            toolUses.put(index.intValue(), pending);
                        }
                    }
                    case "content_block_delta" -> {
                        int index = event.get("index") instanceof Number n ? n.intValue() : 0;
                        if (!(event.get("delta") instanceof Map<?, ?> delta)) continue;
                        String type = String.valueOf(delta.get("type"));
                        if ("text_delta".equals(type) && delta.get("text") instanceof String text && !text.isEmpty()) {
                            content.append(text);
                            events.accept(ChatEvent.stream(text));
                        } else if ("thinking_delta".equals(type) && delta.get("thinking") instanceof String text && !text.isEmpty()) {
                            reasoning.append(text);
                            events.accept(ChatEvent.reasoning(text));
                        } else if ("input_json_delta".equals(type) && delta.get("partial_json") instanceof String partial) {
                            PendingToolUse pending = toolUses.get(index);
                            if (pending != null) pending.inputJson.append(partial);
                        }
                    }
                    case "error" -> {
                        String errorType = event.get("error") instanceof Map<?, ?> err ? String.valueOf(err.get("type")) : "";
                        String message = event.get("error") instanceof Map<?, ?> err ? String.valueOf(err.get("message")) : "";
                        int status = "rate_limit_error".equals(errorType) ? 429
                                : "overloaded_error".equals(errorType) ? 529 : 500;
                        throw new ChatHttpException(status, "Anthropic SSE error"
                                + (errorType.isBlank() ? "" : " (" + errorType + ")")
                                + (message.isBlank() ? "" : "：" + message));
                    }
                    default -> { /* ping / message_delta / content_block_stop / message_stop 忽略 */ }
                }
            }
        }
        Map<String, Object> assistant = new LinkedHashMap<>();
        assistant.put("role", "assistant");
        if (content.length() > 0) assistant.put("content", content.toString());
        if (reasoning.length() > 0) assistant.put("reasoning", reasoning.toString());
        if (!toolUses.isEmpty()) {
            List<Map<String, Object>> calls = new ArrayList<>();
            for (PendingToolUse pending : toolUses.values()) {
                String callId = pending.id.isBlank() ? "toolu_" + System.nanoTime() : pending.id;
                Object parsedArgs;
                try {
                    parsedArgs = Json.parse(pending.inputJson.toString());
                } catch (RuntimeException ignored) {
                    parsedArgs = Map.of();
                }
                Map<String, Object> function = new LinkedHashMap<>();
                function.put("name", pending.name);
                function.put("arguments", Json.stringify(parsedArgs));
                Map<String, Object> call = new LinkedHashMap<>();
                call.put("id", callId);
                call.put("type", "function");
                call.put("function", function);
                calls.add(call);
                Map<String, Object> args = parsedArgs instanceof Map<?, ?> map ? toStringMap(map) : Map.of();
                events.accept(ChatEvent.toolCall(new AgentToolCall(callId, pending.name, args)));
            }
            assistant.put("tool_calls", calls);
        }
        events.accept(ChatEvent.turnComplete(content.toString()));
        return assistant;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> toStringMap(Map<?, ?> map) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }

    private static String readAll(InputStream input) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            StringBuilder out = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) out.append(line).append('\n');
            return out.toString();
        }
    }

    private record AnthropicRequest(String system, List<Map<String, Object>> messages) {}

    private static final class PendingToolUse {
        String id = "";
        String name = "";
        final StringBuilder inputJson = new StringBuilder();
    }
}
