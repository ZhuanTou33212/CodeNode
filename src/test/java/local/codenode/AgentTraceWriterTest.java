package local.codenode.agent;

import local.codenode.Json;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P2 trace 持久化：AgentTraceWriter 写 JSONL、追加、事件字段完整。
 */
class AgentTraceWriterTest {
    @TempDir
    Path temp;

    @Test
    void appendsJsonLinesWithTimestampAndType() throws Exception {
        AgentTraceWriter writer = new AgentTraceWriter(temp, "session-1");
        writer.event("session_start", Map.of("task", "扫描项目"));
        writer.event("tool_call", Map.of("tool", "scan_project", "ok", true, "durationMs", 12L));
        writer.close();
        List<String> lines = Files.readAllLines(writer.file(), StandardCharsets.UTF_8);
        assertEquals(2, lines.size());
        Map<String, Object> first = Json.object(lines.get(0));
        assertEquals("session_start", first.get("type"));
        assertEquals("扫描项目", first.get("task"));
        assertFalse(String.valueOf(first.get("ts")).isBlank(), "应有时间戳");
        Map<String, Object> second = Json.object(lines.get(1));
        assertEquals("scan_project", second.get("tool"));
        assertEquals(true, second.get("ok"));
    }

    @Test
    void appendsAcrossMultipleWritersToSameSession() throws Exception {
        new AgentTraceWriter(temp, "session-2").event("session_start", Map.of());
        new AgentTraceWriter(temp, "session-2").event("session_end", Map.of("state", "COMPLETED"));
        List<String> lines = Files.readAllLines(temp.resolve(".codenode/agent-traces/session-2.jsonl"));
        assertEquals(2, lines.size(), "同一 session 的 trace 应追加而非覆盖");
    }

    @Test
    void sanitizesSessionId() {
        AgentTraceWriter writer = new AgentTraceWriter(temp, "a/b:c");
        assertTrue(writer.file().getFileName().toString().startsWith("a_b_c"));
    }

    @Test
    void writeFailureDoesNotThrow() {
        // 无权限/只读路径等失败场景应静默
        AgentTraceWriter writer = new AgentTraceWriter(temp.resolve("nonexistent-root"), "s");
        writer.event("session_start", Map.of());
    }
}
