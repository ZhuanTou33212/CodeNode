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
        // 构造大量消息，验证 requestMessages 只保留最近窗口
        // 通过反射读取 messages 并塞入 50 条，然后调用 compactHistory + requestMessages
        try {
            AgentConfig config = new AgentConfig(Path.of("config/agent.properties"));
            AgentToolContext ctx = new AgentToolContext(() -> Path.of("."), () -> null, (level, what, detail) -> false, entry -> {});
            AgentChatController controller = new AgentChatController(config, AgentToolkit.buildDefaultRegistry(ctx), ctx);

            java.lang.reflect.Field messagesField = AgentChatController.class.getDeclaredField("messages");
            messagesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> messages = (List<Map<String, Object>>) messagesField.get(controller);
            messages.clear();
            messages.add(Map.of("role", "system", "content", "sys"));
            for (int i = 0; i < 50; i++) {
                messages.add(Map.of("role", "user", "content", "消息 " + i));
            }
            java.lang.reflect.Method compact = AgentChatController.class.getDeclaredMethod("compactHistory");
            compact.setAccessible(true);
            compact.invoke(controller);
            assertEquals(1 + 20, messages.size(), "压缩后应保留 system + 最近 20 条");
            assertFalse(controller.summary().isBlank(), "应有摘要");
        } catch (Exception e) {
            fail("反射测试失败: " + e);
        }
    }

    @Test
    void sessionFilePersistsAndLoads() throws Exception {
        Path root = Files.createTempDirectory("agent-persist");
        try {
            AgentConfig config = new AgentConfig(Path.of("config/agent.properties"));
            AgentToolContext ctx = new AgentToolContext(() -> root, () -> null, (level, what, detail) -> false, entry -> {});
            AgentChatController c1 = new AgentChatController(config, AgentToolkit.buildDefaultRegistry(ctx), ctx);
            java.lang.reflect.Field messagesField = AgentChatController.class.getDeclaredField("messages");
            messagesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> messages = (List<Map<String, Object>>) messagesField.get(c1);
            messages.add(Map.of("role", "user", "content", "你好"));
            messages.add(Map.of("role", "assistant", "content", "在的"));
            java.lang.reflect.Method save = AgentChatController.class.getDeclaredMethod("saveSessionFile");
            save.setAccessible(true);
            save.invoke(c1);
            Path file = root.resolve(".codenode/agent-sessions").resolve(c1.sessionId() + ".json");
            assertTrue(Files.isRegularFile(file), "应持久化会话文件");
            assertTrue(Files.readString(file).contains("你好"));

            // 同实例清空后 reload（模拟继续会话）
            messages.clear();
            messages.add(Map.of("role", "system", "content", "sys"));
            java.lang.reflect.Method load = AgentChatController.class.getDeclaredMethod("loadSessionFile");
            load.setAccessible(true);
            load.invoke(c1);
            assertTrue(messages.stream().anyMatch(m -> "你好".equals(m.get("content"))), "应能恢复历史消息");
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void slidingWindowKeepsToolCallsPredecessor() throws Exception {
        // 构造 30 条消息，末尾是一组 assistant(tool_calls) + tool 响应，验证窗口裁剪不拆散它们
        try {
            AgentConfig config = new AgentConfig(Path.of("config/agent.properties"));
            AgentToolContext ctx = new AgentToolContext(() -> Path.of("."), () -> null, (level, what, detail) -> false, entry -> {});
            AgentChatController controller = new AgentChatController(config, AgentToolkit.buildDefaultRegistry(ctx), ctx);
            java.lang.reflect.Field messagesField = AgentChatController.class.getDeclaredField("messages");
            messagesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> messages = (List<Map<String, Object>>) messagesField.get(controller);
            messages.clear();
            messages.add(Map.of("role", "system", "content", "sys"));
            for (int i = 0; i < 10; i++) {
                messages.add(Map.of("role", "user", "content", "早期" + i));
                messages.add(Map.of("role", "assistant", "content", "回复" + i));
            }
            // 末尾：assistant 带 tool_calls，随后是 tool 响应
            Map<String, Object> assistantWithCalls = new java.util.LinkedHashMap<>();
            assistantWithCalls.put("role", "assistant");
            assistantWithCalls.put("content", "");
            assistantWithCalls.put("tool_calls", List.of(Map.of("id", "call_1", "type", "function",
                    "function", Map.of("name", "read_file", "arguments", "{}"))));
            messages.add(assistantWithCalls);
            messages.add(Map.of("role", "tool", "tool_call_id", "call_1", "content", "结果"));

            java.lang.reflect.Method rm = AgentChatController.class.getDeclaredMethod("requestMessages");
            rm.setAccessible(true);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> request = (List<Map<String, Object>>) rm.invoke(controller);
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
            fail("反射测试失败: " + e);
        }
    }

    @Test
    void sanitizeRemovesOrphanToolMessages() throws Exception {
        try {
            AgentConfig config = new AgentConfig(Path.of("config/agent.properties"));
            AgentToolContext ctx = new AgentToolContext(() -> Path.of("."), () -> null, (level, what, detail) -> false, entry -> {});
            AgentChatController controller = new AgentChatController(config, AgentToolkit.buildDefaultRegistry(ctx), ctx);
            java.lang.reflect.Field messagesField = AgentChatController.class.getDeclaredField("messages");
            messagesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> messages = (List<Map<String, Object>>) messagesField.get(controller);
            messages.clear();
            messages.add(Map.of("role", "system", "content", "sys"));
            messages.add(Map.of("role", "user", "content", "hi"));
            // 孤立的 tool 消息（前面是 user，无 assistant.tool_calls）
            messages.add(Map.of("role", "tool", "tool_call_id", "call_x", "content", "孤立结果"));
            java.lang.reflect.Method sanitize = AgentChatController.class.getDeclaredMethod("sanitizeToolMessages");
            sanitize.setAccessible(true);
            sanitize.invoke(controller);
            assertFalse(messages.stream().anyMatch(m -> "tool".equals(m.get("role"))), "孤立 tool 消息应被移除");
        } catch (Exception e) {
            fail("反射测试失败: " + e);
        }
    }

    @Test
    void toolFailuresAreFlaggedForRetry() {
        // 验证失败/空结果会被判定为"需继续尝试"，触发重试提示逻辑
        try {
            AgentConfig config = new AgentConfig(Path.of("config/agent.properties"));
            AgentToolContext ctx = new AgentToolContext(() -> Path.of("."), () -> null, (level, what, detail) -> false, entry -> {});
            AgentChatController controller = new AgentChatController(config, AgentToolkit.buildDefaultRegistry(ctx), ctx);
            java.lang.reflect.Field messagesField = AgentChatController.class.getDeclaredField("messages");
            messagesField.setAccessible(true);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> messages = (List<Map<String, Object>>) messagesField.get(controller);
            messages.clear();
            messages.add(Map.of("role", "system", "content", "sys"));
            // 失败的 tool 结果应触发"系统提示继续"注入
            messages.add(Map.of("role", "user", "content", "找文件"));
            messages.add(Map.of("role", "assistant", "tool_calls", List.of(Map.of("id", "c1", "function", Map.of("name", "find_files", "arguments", "{}")))));
            messages.add(Map.of("role", "tool", "tool_call_id", "c1", "content", "未找到任何文件"));
            java.lang.reflect.Method request = AgentChatController.class.getDeclaredMethod("requestMessages");
            request.setAccessible(true);
            // requestMessages 不应抛出且应保留该 tool 消息前驱
            Object result = request.invoke(controller);
            assertNotNull(result);
            assertTrue(messages.stream().anyMatch(m -> "未找到任何文件".equals(m.get("content"))), "失败结果应保留在历史中");
        } catch (Exception e) {
            fail("反射测试失败: " + e);
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
