package local.codenode;

import local.codenode.agent.TaskManager;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.impl.TodoTools;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class TodoToolsTest {
    @TempDir Path tempDir;

    @Test void toolsExposeCrudAndStructuredResults() throws Exception {
        TaskManager tasks = new TaskManager(tempDir, "tool-doc");
        AgentToolContext context = new AgentToolContext(() -> tempDir, () -> null, null, null);
        context.setTaskManagerSupplier(() -> tasks);
        AgentToolRegistry registry = new AgentToolRegistry();
        TodoTools.register(registry);

        AgentToolResult added = registry.execute("todo_add", Map.of("desc", "Inspect graph", "note", "first"), context);
        assertTrue(added.ok(), added.text());
        assertEquals(1, added.data().get("count"));
        String id = String.valueOf(((Map<?, ?>) added.data().get("task")).get("id"));

        AgentToolResult updated = registry.execute("todo_update",
                Map.of("id", id, "status", "in_progress", "note", "working"), context);
        assertTrue(updated.ok(), updated.text());
        assertEquals("in_progress", ((Map<?, ?>) updated.data().get("task")).get("status"));

        AgentToolResult listed = registry.execute("todo_list", Map.of(), context);
        assertTrue(listed.ok());
        assertEquals(1, listed.data().get("count"));

        AgentToolResult cleared = registry.execute("todo_clear", Map.of(), context);
        assertTrue(cleared.ok());
        assertEquals(0, cleared.data().get("count"));
        assertTrue(new TaskManager(tempDir, "tool-doc").list().isEmpty());
    }

    @Test void toolsRejectInvalidStatusUnknownIdAndEmptyUpdate() throws Exception {
        TaskManager tasks = new TaskManager(tempDir, "errors-doc");
        AgentToolContext context = new AgentToolContext(() -> tempDir, () -> null, null, null);
        context.setTaskManagerSupplier(() -> tasks);
        AgentToolRegistry registry = new AgentToolRegistry();
        TodoTools.register(registry);

        assertFalse(registry.execute("todo_add", Map.of("desc", "X", "status", "bogus"), context).ok());
        assertFalse(registry.execute("todo_update", Map.of("id", "missing", "status", "done"), context).ok());
        TaskManager.Task task = tasks.add("Real");
        assertFalse(registry.execute("todo_update", Map.of("id", task.id()), context).ok());
    }
}
