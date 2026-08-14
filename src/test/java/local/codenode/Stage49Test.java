package local.codenode;

import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.PermissionMemory;
import local.codenode.agent.SoftwareInfoProvider;
import local.codenode.agent.AgentChatController;
import local.codenode.config.AgentConfig;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.impl.AgentToolkit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipFile;

import static org.junit.jupiter.api.Assertions.*;

class Stage49Test {
    @Test void multiSessionContextRoundTripPreservesTabsAndFiltersSystemMessages() throws Exception {
        AgentContext one = AgentContext.multi("s2", List.of(
                new AgentContext.SessionContext("s1", "Conversation 1", "first", Instant.now(),
                        List.of(Map.of("role", "system", "content", "secret prompt"), Map.of("role", "user", "content", "one"))),
                new AgentContext.SessionContext("s2", "Review", "second", Instant.now(),
                        List.of(Map.of("role", "assistant", "content", "two")))));
        AgentContext restored = AgentContext.fromMap(Json.object(new String(one.toJsonBytes(), StandardCharsets.UTF_8)));
        assertEquals(2, restored.allSessions().size());
        assertEquals("s2", restored.activeSessionId());
        assertEquals(List.of("Conversation 1", "Review"), restored.allSessions().stream().map(AgentContext.SessionContext::title).toList());
        assertTrue(restored.allSessions().stream().flatMap(s -> s.messages().stream())
                .noneMatch(m -> "system".equals(m.get("role"))));
        assertTrue(restored.toJsonBytes().length <= AgentContext.MAX_CHARS);
    }
    @TempDir Path temp;

    @Test
    void contextIsBoundedAndRoundTrips() throws Exception {
        String large = "x".repeat(120_000);
        List<Map<String, Object>> messages = new ArrayList<>();
        for (int i = 0; i < 12; i++) messages.add(Map.of("role", "user", "content", i + large));
        AgentContext context = AgentContext.of("session", "summary", messages);
        byte[] encoded = CnodeProjectCodec.encodeAgentContext(context);
        assertTrue(encoded.length <= AgentContext.MAX_CHARS);
        AgentContext restored = CnodeProjectCodec.decodeAgentContext(encoded);
        assertEquals("session", restored.sessionId());
        assertTrue(restored.truncated());
        assertTrue(restored.messages().size() < messages.size());
    }

    @Test
    void unicodeContextIsByteBoundedAndSystemMessagesAreExcluded() throws Exception {
        List<Map<String, Object>> messages = new ArrayList<>();
        messages.add(Map.of("role", "system", "content", "do not persist"));
        for (int i = 0; i < 6; i++) messages.add(Map.of("role", "user", "content", "中".repeat(180_000)));
        AgentContext context = AgentContext.of("unicode", "摘要", messages);
        assertTrue(context.toJsonBytes().length <= AgentContext.MAX_CHARS);
        assertTrue(context.messages().stream().noneMatch(m -> "system".equals(m.get("role"))));
        assertTrue(context.truncated());
    }

    @Test
    void cnodePersistsAgentEntriesWithIntegrity() throws Exception {
        WorkflowModel model = new WorkflowModel(); model.addNode(10, 20);
        var settings = new CnodeProjectCodec.Settings(WorkflowModel.Mode.MARKDOWN, "java", "output/app", "output/docs", null, 0, 0, 1.0, null);
        var metadata = new CnodeProjectCodec.Metadata("doc-stage49", "stage49", Instant.now(), settings);
        AgentContext context = AgentContext.of("session", "summary", List.of(Map.of("role", "user", "content", "hello")));
        AgentInfoSnapshot info = new AgentInfoSnapshot(Map.of("version", "0.16", "projectRoot", "E:\\private\\demo"), Map.of("jdk", "21"));
        Path file = temp.resolve("stage49.cnode");
        CnodeProjectCodec codec = new CnodeProjectCodec();
        codec.save(file, model, metadata, context, info);
        assertEquals("session", codec.loadAgentContext(file).orElseThrow().sessionId());
        assertEquals("21", codec.loadAgentInfo(file).orElseThrow().values().get("jdk"));
        try (ZipFile zip = new ZipFile(file.toFile(), StandardCharsets.UTF_8)) {
            assertNotNull(zip.getEntry("agent-context.json"));
            assertNotNull(zip.getEntry("agent-info.json"));
            String integrity = new String(zip.getInputStream(zip.getEntry("integrity.json")).readAllBytes(), StandardCharsets.UTF_8);
            assertTrue(integrity.contains("agent-context.json"));
            assertTrue(integrity.contains("agent-info.json"));
        }
    }

    @Test
    void snapshotUsesAllowListAndRedactsAbsoluteProjectPath() {
        AgentInfoSnapshot snapshot = new AgentInfoSnapshot(
                Map.of("api_key", "secret", "api_base", "https://private", "password", "pw", "projectRoot", "E:\\private\\demo", "version", "0.16", "mode", "markdown", "canvasNodes", 7),
                Map.of("jdk", "21"));
        String text = snapshot.toText();
        assertFalse(text.contains("secret"));
        assertFalse(text.contains("https://private"));
        assertFalse(text.contains("pw"));
        assertFalse(text.contains("E:\\private"));
        assertTrue(text.contains("0.16"));
        assertTrue(text.contains("markdown"));
        assertTrue(text.contains("7"));
    }

    @Test
    void snapshotJsonHasSchemaAndHardUtf8Boundary() {
        AgentInfoSnapshot snapshot = new AgentInfoSnapshot(
                Map.of("version", "0.16", "uiActions", List.of("中".repeat(400_000)), "projectRoot", temp.toString()), Map.of());
        byte[] bytes = snapshot.toJsonBytes();
        assertTrue(bytes.length <= AgentInfoSnapshot.MAX_CHARS);
        String json = new String(bytes, StandardCharsets.UTF_8);
        assertTrue(json.contains("schemaVersion"));
        assertTrue(json.contains("generator"));
        assertThrows(IllegalArgumentException.class, () -> AgentInfoSnapshot.fromJson(Map.of("schemaVersion", 2)));
    }

    @Test
    void permissionsEnforceGlobalAndUiSwitchesAndRememberSessionDecision() {
        AtomicInteger confirms = new AtomicInteger();
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new,
                (level, what, detail) -> { confirms.incrementAndGet(); return true; }, entry -> {},
                null, null, null, null, null, (action, arguments) -> true);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);

        context.setPermissionSupplier(() -> "system:disabled,ui:allow,write:confirm,execute:confirm");
        assertFalse(registry.execute("ui_control", Map.of("action", "view_all"), context).ok());

        context.setPermissionSupplier(() -> "system:enabled,ui:disabled,write:confirm,execute:confirm");
        assertFalse(registry.execute("ui_control", Map.of("action", "view_all"), context).ok());

        context.setPermissionSupplier(() -> "system:enabled,ui:confirm,write:confirm,execute:confirm");
        assertTrue(registry.execute("ui_control", Map.of("action", "view_all"), context).ok());
        assertTrue(registry.execute("ui_control", Map.of("action", "view_all"), context).ok());
        assertEquals(1, confirms.get());
        context.setRememberApprovals(false);
        assertTrue(registry.execute("ui_control", Map.of("action", "view_all"), context).ok());
        assertTrue(registry.execute("ui_control", Map.of("action", "view_all"), context).ok());
        assertEquals(3, confirms.get());
        assertFalse(registry.execute("ui_control", Map.of("action", "not_real"), context).ok());
    }

    @Test
    void readUiStateReturnsStructuredAllowListedSnapshot() {
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new,
                (level, what, detail) -> true, entry -> {}, null, null, null, null, null,
                (action, arguments) -> true);
        context.setPermissionSupplier(() -> "system:enabled,ui:allow");
        context.setSoftwareInfoProvider(new SoftwareInfoProvider() {
            public Map<String, Object> softwareInfo() { return Map.of("version", "0.16", "canvasNodes", 5, "api_key", "secret"); }
            public Map<String, Object> environmentInfo() { return Map.of("jdk", "21"); }
        });
        AgentToolResult result = AgentToolkit.buildDefaultRegistry(context).execute("ui_control", Map.of("action", "read_ui_state"), context);
        assertTrue(result.ok());
        assertEquals(5, result.data().get("canvasNodes"));
        assertEquals("21", result.data().get("jdk"));
        assertFalse(result.data().containsKey("api_key"));
    }

    @Test
    void uiControlRunsOnEdtAndRejectsInvalidArguments() {
        AtomicBoolean edt = new AtomicBoolean(false);
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new,
                (level, what, detail) -> true, entry -> {}, null, null, null, null, null,
                (action, arguments) -> { edt.set(javax.swing.SwingUtilities.isEventDispatchThread()); return true; });
        context.setPermissionSupplier(() -> "system:enabled,ui:allow,execute:allow");
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        assertTrue(registry.execute("ui_control", Map.of("action", "view_all"), context).ok());
        assertTrue(edt.get());
        assertFalse(registry.execute("ui_control", Map.of("action", "zoom"), context).ok());
        assertFalse(registry.execute("ui_control", Map.of("action", "view_all", "bogus", 1), context).ok());
    }

    @Test
    void uiSchemaRequiresEnumeratedActionAndNoExtraProperties() {
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new,
                (level, what, detail) -> true, entry -> {}, null, null, null, null, null,
                (action, arguments) -> true);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        Map<String, Object> schema = registry.listTools().stream().filter(t -> t.name().equals("ui_control")).findFirst().orElseThrow().inputSchema();
        assertEquals(List.of("action"), schema.get("required"));
        assertEquals(false, schema.get("additionalProperties"));
        Map<?, ?> action = (Map<?, ?>) ((Map<?, ?>) schema.get("properties")).get("action");
        assertTrue(((List<?>) action.get("enum")).contains("new_content"));
    }

    @Test
    void permissionMemoryIsSessionScoped() {
        PermissionMemory memory = new PermissionMemory();
        memory.remember("tool|arg", true);
        assertTrue(memory.get("tool|arg"));
        memory.clear();
        assertNull(memory.get("tool|arg"));
    }

    @Test
    void controllerRestoresSessionWithoutPersistingSystemPrompt() throws Exception {
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new,
                (level, what, detail) -> true, entry -> {});
        context.setSoftwareInfoProvider(new SoftwareInfoProvider() {
            private final AtomicInteger captures = new AtomicInteger();
            public Map<String, Object> softwareInfo() { return Map.of("version", "v" + captures.incrementAndGet()); }
            public Map<String, Object> environmentInfo() { return Map.of(); }
        });
        AgentChatController controller = new AgentChatController(new AgentConfig(temp.resolve("agent.properties")), AgentToolkit.buildDefaultRegistry(context), context);
        AgentContext saved = AgentContext.of("restored-session", "summary", List.of(
                Map.of("role", "system", "content", "stale"), Map.of("role", "user", "content", "hello")));
        controller.restoreContext(saved);
        assertEquals("restored-session", controller.sessionId());
        assertEquals(1, controller.messageHistory().size());
        assertEquals("user", controller.messageHistory().getFirst().get("role"));

        java.lang.reflect.Field messagesField = AgentChatController.class.getDeclaredField("messages");
        messagesField.setAccessible(true);
        @SuppressWarnings("unchecked") List<Map<String, Object>> internal = (List<Map<String, Object>>) messagesField.get(controller);
        assertEquals(2, internal.size());
        assertEquals("system", internal.getFirst().get("role"));
        assertFalse(String.valueOf(internal.getFirst().get("content")).contains("stale"));

        java.lang.reflect.Method systemPrompt = AgentChatController.class.getDeclaredMethod("systemPrompt");
        systemPrompt.setAccessible(true);
        String first = String.valueOf(((Map<?, ?>) systemPrompt.invoke(controller)).get("content"));
        String second = String.valueOf(((Map<?, ?>) systemPrompt.invoke(controller)).get("content"));
        assertNotEquals(first, second, "每次构造系统提示都应重新采集软件快照");
    }

    @Test
    void agentContextRejectsUnknownSchemaVersion() {
        assertThrows(IllegalArgumentException.class, () -> AgentContext.fromMap(Map.of("schemaVersion", 99)));
    }
}
