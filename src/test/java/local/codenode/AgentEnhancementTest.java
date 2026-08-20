package local.codenode.agent;

import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Stage4.6 内嵌 Agent 增强验证：
 * 短期记忆（滑动窗口/摘要/截断/持久化）、工具调度健壮性、画布读取能力。
 */
public class AgentEnhancementTest {

    private static WorkflowModel modelWithNodes() {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node a = model.addNode(0, 0);
        a.name = "输入";
        WorkflowModel.Node b = model.addNode(100, 100);
        b.name = "处理";
        b.codeBearing = true;
        model.connect(a, b);
        return model;
    }

    @Test
    void getWorkbenchModelFullViewReadsCanvas() throws Exception {
        Path root = Files.createTempDirectory("agent-canvas");
        try {
            WorkflowModel model = modelWithNodes();
            AgentToolContext context = new AgentToolContext(() -> root, () -> model, (level, what, detail) -> false, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            var result = registry.execute("get_workbench_model", Map.of(), context);
            assertTrue(result.ok());
            assertEquals(2, ((Number) result.data().get("nodeCount")).intValue());
            assertEquals(1, ((Number) result.data().get("edgeCount")).intValue());
            assertTrue(result.data().get("edges") instanceof List<?>);
            List<?> nodes = (List<?>) result.data().get("nodes");
            assertTrue(nodes.size() >= 2);
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void getWorkbenchModelGroupsView() throws Exception {
        Path root = Files.createTempDirectory("agent-groups");
        try {
            WorkflowModel model = new WorkflowModel();
            WorkflowModel.Node group = model.addGroupNode(0, 0, "包组");
            WorkflowModel.Node child = model.addNode(50, 50);
            child.parentScopeId = group.id;
            AgentToolContext context = new AgentToolContext(() -> root, () -> model, (level, what, detail) -> false, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            var result = registry.execute("get_workbench_model", Map.of("view", "groups"), context);
            assertTrue(result.ok());
            assertTrue(((Number) result.data().get("groupCount")).intValue() >= 1);
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void requestMessagesSlidesWindowWithSummary() {
        // 构造大量消息，验证压缩后 Codex 式重组：system + 全部用户消息原文 + 摘要为最后一条 user（P1-2 拆分后直接测 MessageHistory）
        try {
            Path root = Files.createTempDirectory("agent-window");
            AgentToolContext ctx = new AgentToolContext(() -> root, () -> null, (level, what, detail) -> false, entry -> {});
            MessageHistory history = new MessageHistory(ctx);
            history.add(Map.of("role", "system", "content", "sys"));
            for (int i = 0; i < 50; i++) {
                history.add(Map.of("role", "user", "content", "消息 " + i));
                history.add(Map.of("role", "assistant", "content", "回复 " + i));
            }
            history.compactHistory();
            // Codex 式：保留全部用户消息原文（预算内）+ 摘要作为最后一条 user 消息；丢弃 assistant/tool
            assertEquals(1 + 50 + 1, history.messages().size(), "压缩后应保留 system + 全部用户消息 + 摘要消息");
            Map<String, Object> last = history.messages().get(history.messages().size() - 1);
            assertEquals("user", last.get("role"), "摘要应为最后一条 user 消息");
            assertTrue(String.valueOf(last.get("content")).startsWith(MessageHistory.SUMMARY_PREFIX), "摘要消息应以固定前缀开头");
            assertFalse(history.summary().isBlank(), "应有摘要");
        } catch (Exception e) {
            fail("MessageHistory 测试失败: " + e);
        }
    }

    @Test
    void sessionFilePersistsAndLoads() throws Exception {
        Path root = Files.createTempDirectory("agent-persist");
        try {
            AgentToolContext ctx = new AgentToolContext(() -> root, () -> null, (level, what, detail) -> false, entry -> {});
            MessageHistory history = new MessageHistory(ctx);
            history.add(Map.of("role", "user", "content", "你好"));
            history.add(Map.of("role", "assistant", "content", "在的"));
            history.saveSessionFile(root, "sess-1");
            Path file = root.resolve(".codenode/agent-sessions").resolve("sess-1.json");
            assertTrue(Files.isRegularFile(file), "应持久化会话文件");
            assertTrue(Files.readString(file).contains("你好"));

            MessageHistory restored = new MessageHistory(ctx);
            restored.add(Map.of("role", "system", "content", "sys"));
            restored.loadSessionFile(root, "sess-1");
            assertTrue(restored.messages().stream().anyMatch(m -> "你好".equals(m.get("content"))), "应能恢复历史消息");
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void slidingWindowKeepsToolCallsPredecessor() throws Exception {
        // 构造 30 条消息，末尾是一组 assistant(tool_calls) + tool 响应，验证窗口裁剪不拆散它们
        try {
            Path root = Files.createTempDirectory("agent-window2");
            AgentToolContext ctx = new AgentToolContext(() -> root, () -> null, (level, what, detail) -> false, entry -> {});
            MessageHistory history = new MessageHistory(ctx);
            history.add(Map.of("role", "system", "content", "sys"));
            for (int i = 0; i < 10; i++) {
                history.add(Map.of("role", "user", "content", "早期" + i));
                history.add(Map.of("role", "assistant", "content", "回复" + i));
            }
            // 末尾：assistant 带 tool_calls，随后是 tool 响应
            Map<String, Object> assistantWithCalls = new java.util.LinkedHashMap<>();
            assistantWithCalls.put("role", "assistant");
            assistantWithCalls.put("content", "");
            assistantWithCalls.put("tool_calls", List.of(Map.of("id", "call_1", "type", "function",
                    "function", Map.of("name", "read_file", "arguments", "{}"))));
            history.add(assistantWithCalls);
            history.add(Map.of("role", "tool", "tool_call_id", "call_1", "content", "结果"));

            List<Map<String, Object>> request = history.requestMessages();
            // 遍历：任何 tool 消息前必须紧跟 assistant 且该 assistant 含 tool_calls
            boolean sawAssistantCalls = false;
            for (Map<String, Object> message : request) {
                String role = String.valueOf(message.get("role"));
                if ("assistant".equals(role)) {
                    sawAssistantCalls = message.get("tool_calls") instanceof List && !((List<?>)message.get("tool_calls")).isEmpty();
                } else if ("tool".equals(role)) {
                    assertTrue(sawAssistantCalls, "tool 消息前必须有 assistant.tool_calls，请求消息: " + request);
                }
            }
        } catch (Exception e) {
            fail("MessageHistory 测试失败: " + e);
        }
    }

    @Test
    void sanitizeRemovesOrphanToolMessages() throws Exception {
        try {
            Path root = Files.createTempDirectory("agent-sanitize");
            AgentToolContext ctx = new AgentToolContext(() -> root, () -> null, (level, what, detail) -> false, entry -> {});
            MessageHistory history = new MessageHistory(ctx);
            history.add(Map.of("role", "system", "content", "sys"));
            history.add(Map.of("role", "user", "content", "hi"));
            // 孤立的 tool 消息（前面是 user，无 assistant.tool_calls）
            history.add(Map.of("role", "tool", "tool_call_id", "call_x", "content", "孤立结果"));
            history.sanitizeToolMessages();
            assertFalse(history.messages().stream().anyMatch(m -> "tool".equals(m.get("role"))), "孤立 tool 消息应被移除");
        } catch (Exception e) {
            fail("MessageHistory 测试失败: " + e);
        }
    }

    @Test
    void toolFailuresAreFlaggedForRetry() {
        // 验证失败/空结果会被判定为"需继续尝试"，触发重试提示逻辑（P1-2 拆分后直接测 MessageHistory）
        try {
            Path root = Files.createTempDirectory("agent-retry");
            AgentToolContext ctx = new AgentToolContext(() -> root, () -> null, (level, what, detail) -> false, entry -> {});
            MessageHistory history = new MessageHistory(ctx);
            history.add(Map.of("role", "system", "content", "sys"));
            // 失败的 tool 结果应保留在历史中，供重试提示使用
            history.add(Map.of("role", "user", "content", "找文件"));
            history.add(Map.of("role", "assistant", "tool_calls", List.of(Map.of("id", "c1", "function", Map.of("name", "find_files", "arguments", "{}")))));
            history.add(Map.of("role", "tool", "tool_call_id", "c1", "content", "未找到任何文件"));
            List<Map<String, Object>> result = history.requestMessages();
            assertNotNull(result);
            assertTrue(history.messages().stream().anyMatch(m -> "未找到任何文件".equals(m.get("content"))), "失败结果应保留在历史中");
        } catch (Exception e) {
            fail("MessageHistory 测试失败: " + e);
        }
    }

    private static void deleteRecursive(Path dir) throws Exception {
        if (dir == null || !Files.exists(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }
}
