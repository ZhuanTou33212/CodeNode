package local.codenode.agent.mcp;

import local.codenode.Json;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 极简 MCP stdio client（零依赖，JSON-RPC 2.0 over 子进程 stdin/stdout）。
 *
 * <p>与 {@code CodeNodeMcpServer} 的线协议一致：每行一个 JSON-RPC 消息。连接时完成
 * {@code initialize} 握手与 {@code notifications/initialized} 通知，随后可通过
 * {@code tools/list} / {@code tools/call} 将外部 MCP server 的工具并入内置 Agent
 * 的 {@code AgentToolRegistry}。同一 client 的请求串行执行（synchronized）。</p>
 */
public final class McpStdioClient implements AutoCloseable {

    /** MCP 协议版本（与 CodeNodeMcpServer 一致）。 */
    public static final String PROTOCOL_VERSION = "2024-11-05";

    /** 远端工具的元数据（与 OpenAI function parameters 兼容的 inputSchema）。 */
    public record ToolSpec(String name, String description, Map<String, Object> inputSchema) {}

    /** 远端 tools/call 结果。 */
    public record CallResult(boolean isError, String text) {}

    private final String name;
    private final Process process;
    private final BufferedWriter stdin;
    private final BlockingQueue<Map<String, Object>> responses;
    private final AtomicLong nextId = new AtomicLong(1);
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final Thread readerThread;

    private McpStdioClient(String name, Process process, BufferedWriter stdin, Thread readerThread,
                           BlockingQueue<Map<String, Object>> responses) {
        this.name = name;
        this.process = process;
        this.stdin = stdin;
        this.readerThread = readerThread;
        this.responses = responses;
    }

    /** 启动子进程并完成 MCP 握手；失败时销毁进程并抛出 IOException。 */
    public static McpStdioClient connect(String name, List<String> command, long timeoutMillis) throws IOException {
        Objects.requireNonNull(name, "name");
        if (command == null || command.isEmpty()) throw new IllegalArgumentException("MCP server 命令为空：" + name);
        Process process;
        try {
            process = new ProcessBuilder(command)
                    .redirectError(ProcessBuilder.Redirect.INHERIT)
                    .start();
        } catch (IOException failure) {
            throw new IOException("无法启动 MCP server '" + name + "'：" + failure.getMessage(), failure);
        }
        BufferedWriter stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        BlockingQueue<Map<String, Object>> responses = new LinkedBlockingQueue<>();
        Thread reader = new Thread(() -> {
            try (BufferedReader reader0 = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader0.readLine()) != null) {
                    if (line.isBlank()) continue;
                    try {
                        Map<String, Object> message = Json.object(line);
                        if (message.get("id") != null) responses.offer(message);
                    } catch (RuntimeException ignored) {
                        // 忽略无法解析的行（如 server 的调试输出）
                    }
                }
            } catch (IOException ignored) {
                // 进程退出/管道关闭
            }
        }, "codenode-mcp-reader-" + name);
        reader.setDaemon(true);
        reader.start();
        McpStdioClient client = new McpStdioClient(name, process, stdin, reader, responses);
        try {
            client.initialize(timeoutMillis);
            return client;
        } catch (IOException | RuntimeException failure) {
            client.close();
            throw failure instanceof IOException io ? io : new IOException(failure.getMessage(), failure);
        }
    }

    public String name() {
        return name;
    }

    /** MCP initialize 握手，随后发送 notifications/initialized。 */
    private void initialize(long timeoutMillis) throws IOException {
        Map<String, Object> result = request("initialize", Map.of(
                "protocolVersion", PROTOCOL_VERSION,
                "capabilities", Map.of(),
                "clientInfo", Map.of("name", "codenode-desktop", "version", "0.1.5")), timeoutMillis);
        Object version = result == null ? null : result.get("protocolVersion");
        if (version == null) throw new IOException("MCP server '" + name + "' 未返回 protocolVersion");
        // 通知无需响应
        write(Map.of("jsonrpc", "2.0", "method", "notifications/initialized"));
    }

    /** 列出远端全部工具。 */
    public List<ToolSpec> listTools(long timeoutMillis) throws IOException {
        Map<String, Object> result = request("tools/list", Map.of(), timeoutMillis);
        if (result == null) return List.of();
        Object raw = result.get("tools");
        if (!(raw instanceof List<?> tools)) return List.of();
        List<ToolSpec> specs = new ArrayList<>();
        for (Object item : tools) {
            if (!(item instanceof Map<?, ?> map)) continue;
            String toolName = String.valueOf(map.get("name"));
            if (toolName.isBlank()) continue;
            String description = map.get("description") instanceof String d ? d : "";
            Map<String, Object> schema = map.get("inputSchema") instanceof Map<?, ?> s
                    ? toStringMap(s) : Map.of("type", "object", "properties", Map.of());
            specs.add(new ToolSpec(toolName, description, schema));
        }
        return List.copyOf(specs);
    }

    /** 调用远端工具；超时/JSON-RPC 错误转为 isError 结果，仅连接级故障抛 IOException。 */
    public CallResult call(String tool, Map<String, Object> arguments, long timeoutMillis) throws IOException {
        Map<String, Object> result;
        try {
            result = request("tools/call", Map.of(
                    "name", tool,
                    "arguments", arguments == null ? Map.of() : arguments), timeoutMillis);
        } catch (IOException failure) {
            // JSON-RPC error（如未知工具）或超时：对模型呈现为工具返回错误，而不是 harness 崩溃
            return new CallResult(true, failure.getMessage());
        }
        if (result == null) return new CallResult(true, "MCP server '" + name + "' 无响应");
        boolean isError = Boolean.TRUE.equals(result.get("isError"));
        StringBuilder text = new StringBuilder();
        if (result.get("content") instanceof List<?> content) {
            for (Object item : content) {
                if (item instanceof Map<?, ?> entry && entry.get("text") instanceof String t) {
                    if (text.length() > 0) text.append('\n');
                    text.append(t);
                }
            }
        }
        Object structured = result.get("structuredContent");
        if (structured != null && text.isEmpty()) {
            text.append(Json.stringify(structured));
        }
        return new CallResult(isError, text.toString());
    }

    /** 发送 JSON-RPC 请求并等待匹配 id 的响应；超时抛 IOException。 */
    private synchronized Map<String, Object> request(String method, Map<String, Object> params, long timeoutMillis) throws IOException {
        ensureOpen();
        long id = nextId.getAndIncrement();
        LinkedHashMap<String, Object> request = new LinkedHashMap<>();
        request.put("jsonrpc", "2.0");
        request.put("id", id);
        request.put("method", method);
        request.put("params", params);
        write(request);
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.max(1, timeoutMillis));
        while (true) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new IOException("MCP server '" + name + "' 调用超时：" + method
                    + " (alive=" + process.isAlive() + " queue=" + responses.size()
                    + " reader=" + readerThread.getState() + ")");
            Map<String, Object> message;
            try {
                message = responses.poll(Math.min(remaining, 250_000_000L), TimeUnit.NANOSECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("MCP 调用被中断：" + method);
            }
            if (message == null) continue;
            if (!(message.get("id") instanceof Number n) || n.longValue() != id) continue;
            if (message.get("error") != null) {
                Object detail = ((Map<?, ?>) message.get("error")).get("message");
                throw new IOException("MCP server '" + name + "' 错误: " + (detail == null ? "未知错误" : detail));
            }
            return toStringMap(asMap(message.get("result")));
        }
    }

    private void write(Map<String, Object> message) throws IOException {
        synchronized (stdin) {
            stdin.write(Json.stringify(message).replace("\n", ""));
            stdin.newLine();
            stdin.flush();
        }
    }

    private void ensureOpen() throws IOException {
        if (closed.get() || !process.isAlive()) throw new IOException("MCP server '" + name + "' 已关闭");
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        try { stdin.close(); } catch (IOException ignored) {}
        process.destroy();
        try {
            if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
        }
        readerThread.interrupt();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
    }

    private static Map<String, Object> toStringMap(Map<?, ?> map) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) result.put(String.valueOf(entry.getKey()), entry.getValue());
        return result;
    }
}
