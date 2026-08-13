package local.codenode;

import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.PermissionMemory;
import local.codenode.agent.SoftwareInfoProvider;
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
import java.util.zip.ZipFile;

import static org.junit.jupiter.api.Assertions.*;

class Stage49Test {
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
    void permissionsEnforceGlobalAndUiSwitchesAndRememberSessionDecision() {
        AtomicInteger confirms = new AtomicInteger();
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new,
                (level, what, detail) -> { confirms.incrementAndGet(); return true; }, entry -> {},
                null, null, null, null, null, (action, arguments) -> {});
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
                (action, arguments) -> {});
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
    void permissionMemoryIsSessionScoped() {
        PermissionMemory memory = new PermissionMemory();
        memory.remember("tool|arg", true);
        assertTrue(memory.get("tool|arg"));
        memory.clear();
        assertNull(memory.get("tool|arg"));
    }
}