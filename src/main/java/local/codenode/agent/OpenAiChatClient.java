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
 * OpenAI 兼容 chat.completions 流式客户端（SSE）。使用 AgentConfig 的 baseUrl / apiKey / model。
 * 支持 delta.content（正式回复）、delta.reasoning_content（推理）与 delta.tool_calls（工具调用）。
 */
public final class OpenAiChatClient implements ChatClient {
    private final AgentConfig config;
    private volatile HttpURLConnection activeConnection;
    /** 最近一次 chat 的 token 用量（读后清除；trace 用，不进入消息历史）。 */
    private volatile Map<String, Object> lastUsage;

    public OpenAiChatClient(AgentConfig config) {
        this.config = config;
    }

    /** 最近一次请求的 usage（prompt/completion tokens），读后清除。 */
    public Map<String, Object> lastUsage() {
        Map<String, Object> usage = lastUsage;
        lastUsage = null;
        return usage;
    }

    public boolean isConfigured() {
        return config.isConfigured();
    }

    public String endpoint() {
        String base = config.apiBase();
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/chat/completions";
    }

    /**
     * 发送流式请求并推送事件；返回最终 assistant 消息（含 tool_calls）供历史追加。
     *
     * @throws IOException           网络/HTTP/配置错误
     * @throws InterruptedException  用户停止
     */
    public Map<String, Object> chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools,
                                    Consumer<ChatEvent> events) throws IOException, InterruptedException {
        if (!config.isConfigured()) {
            throw new IOException("未配置 Agent API（请在“内嵌 Agent → 设置”填写 baseUrl / apiKey / model）");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", config.model());
        body.put("messages", messages);
        body.put("stream", true);
        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools);
            body.put("tool_choice", "auto");
        }

        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint()).openConnection();
        activeConnection = connection;
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("Authorization", "Bearer " + config.apiKey());
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
                throw new IOException("API 返回 " + status + (detail.isBlank() ? "" : "：" + detail.trim()));
            }
            return parseSse(connection.getInputStream(), events);
        } finally {
            activeConnection = null;
        }
    }

    /** 中止当前请求（停止按钮调用）。 */
    public void abort() {
        HttpURLConnection connection = activeConnection;
        if (connection != null) {
            try { connection.disconnect(); } catch (Exception ignored) {}
        }
    }

    private Map<String, Object> parseSse(InputStream input, Consumer<ChatEvent> events) throws IOException, InterruptedException {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        Map<Integer, PendingToolCall> toolCalls = new LinkedHashMap<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException("已停止");
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if (data.isEmpty()) continue;
                if ("[DONE]".equals(data)) break;
                Map<String, Object> chunk;
                try {
                    chunk = Json.object(data);
                } catch (RuntimeException ignored) {
                    continue;
                }
                if (chunk.get("usage") instanceof Map<?, ?> usage) {
                    lastUsage = toStringMap(usage);
                }
                Object choicesObj = chunk.get("choices");
                if (!(choicesObj instanceof List<?> choices) || choices.isEmpty()) continue;
                if (!(choices.get(0) instanceof Map<?, ?> choice)) continue;
                if (!(choice.get("delta") instanceof Map<?, ?> delta)) continue;
                if (delta.get("content") instanceof String text && !text.isEmpty()) {
                    content.append(text);
                    events.accept(ChatEvent.stream(text));
                }
                if (delta.get("reasoning_content") instanceof String text && !text.isEmpty()) {
                    reasoning.append(text);
                    events.accept(ChatEvent.reasoning(text));
                }
                if (delta.get("tool_calls") instanceof List<?> calls) {
                    for (Object callObj : calls) {
                        if (!(callObj instanceof Map<?, ?> call)) continue;
                        int index = call.get("index") instanceof Number n ? n.intValue() : 0;
                        PendingToolCall pending = toolCalls.computeIfAbsent(index, key -> new PendingToolCall());
                        if (call.get("id") instanceof String id && !id.isBlank()) pending.id = id;
                        if (call.get("function") instanceof Map<?, ?> function) {
                            if (function.get("name") instanceof String name && !name.isBlank()) pending.name = name;
                            if (function.get("arguments") instanceof String args) pending.arguments.append(args);
                        }
                    }
                }
            }
        }
        Map<String, Object> assistant = new LinkedHashMap<>();
        assistant.put("role", "assistant");
        if (content.length() > 0) assistant.put("content", content.toString());
        if (reasoning.length() > 0) assistant.put("reasoning", reasoning.toString());
        if (!toolCalls.isEmpty()) {
            List<Map<String, Object>> calls = new ArrayList<>();
            for (PendingToolCall pending : toolCalls.values()) {
                String callId = pending.id.isBlank() ? "call_" + System.nanoTime() : pending.id;
                Object parsedArgs;
                try {
                    parsedArgs = Json.parse(pending.arguments.toString());
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

    private static final class PendingToolCall {
        String id = "";
        String name = "";
        final StringBuilder arguments = new StringBuilder();
    }
}
