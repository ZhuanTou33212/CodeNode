package local.codenode.agent;

import local.codenode.Json;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Agent 执行 trace 的持久化写入器（append-only JSONL）。
 *
 * <p>文件位于 {@code .codenode/agent-traces/<sessionId>.jsonl}，每行一个事件：
 * session_start / llm_call / tool_call / retry_nudge / error / session_end。
 * 记录耗时、工具结果摘要与 token 用量，供离线复盘与 harness 调优；写入失败静默忽略，
 * 绝不影响会话主流程。</p>
 */
public final class AgentTraceWriter implements AutoCloseable {

    private final Path file;

    public AgentTraceWriter(Path projectRoot, String sessionId) {
        Path dir = projectRoot.resolve(".codenode").resolve("agent-traces");
        try {
            Files.createDirectories(dir);
        } catch (IOException ignored) {
            // trace 目录创建失败则放弃写入
        }
        this.file = dir.resolve(sanitize(sessionId) + ".jsonl");
    }

    public Path file() {
        return file;
    }

    /** 追加一条事件（自动附加时间戳与事件类型）。 */
    public synchronized void event(String type, Map<String, Object> fields) {
        try {
            LinkedHashMap<String, Object> record = new LinkedHashMap<>();
            record.put("ts", Instant.now().toString());
            record.put("type", type);
            if (fields != null) record.putAll(fields);
            Files.writeString(file, Json.stringify(record).replace("\n", "") + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) {
            // trace 是尽力而为的观测数据，失败不阻断会话
        }
    }

    @Override
    public void close() {
        // 无资源需要释放（每次写入直接落盘）
    }

    private static String sanitize(String value) {
        String safe = value == null ? "session" : value.replaceAll("[^A-Za-z0-9._-]", "_");
        return safe.isBlank() ? "session" : safe;
    }
}
