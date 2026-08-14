package local.codenode;

import local.codenode.agent.SubagentManager;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.impl.SubagentTools;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class SubagentToolsTest {
    @Test void toolsExposeSpawnWaitAndListLifecycle() {
        try (SubagentManager manager = new SubagentManager(
                (task, relevant, cancellation) -> "done " + task + " using " + relevant)) {
            AgentToolContext context = context(manager);
            AgentToolRegistry registry = registry();

            AgentToolResult spawn = registry.execute("spawn_subagent",
                    Map.of("task", "inspect", "context", "Auth.java"), context);
            assertTrue(spawn.ok());
            String id = subagent(spawn).get("id").toString();

            AgentToolResult wait = registry.execute("subagent_wait",
                    Map.of("id", id, "timeoutSeconds", 2), context);
            assertTrue(wait.ok());
            assertEquals(Boolean.FALSE, wait.data().get("timedOut"));
            assertEquals("completed", subagent(wait).get("status"));
            assertEquals("done inspect using Auth.java", subagent(wait).get("result"));

            AgentToolResult list = registry.execute("subagent_list", Map.of(), context);
            assertTrue(list.ok());
            assertEquals(1, ((List<?>) list.data().get("subagents")).size());
        }
    }

    @Test void cancelToolCancelsRunningWorkAndUnknownIdIsError() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        try (SubagentManager manager = new SubagentManager((task, relevant, cancellation) -> {
            started.countDown();
            while (true) {
                cancellation.throwIfCancelled();
                Thread.sleep(20);
            }
        })) {
            AgentToolContext context = context(manager);
            AgentToolRegistry registry = registry();
            AgentToolResult spawn = registry.execute("spawn_subagent", Map.of("task", "long"), context);
            String id = subagent(spawn).get("id").toString();
            assertTrue(started.await(2, TimeUnit.SECONDS));

            AgentToolResult cancel = registry.execute("subagent_cancel", Map.of("id", id), context);
            assertTrue(cancel.ok());
            assertEquals(Boolean.TRUE, cancel.data().get("cancelled"));
            assertEquals("cancelled", subagent(cancel).get("status"));
            assertFalse(registry.execute("subagent_cancel", Map.of("id", "missing"), context).ok());
        }
    }

    @Test void toolsFailClearlyWhenConversationHasNoManager() {
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), WorkflowModel::new, (l, w, d) -> true, e -> {});
        AgentToolResult result = registry().execute("subagent_list", Map.of(), context);
        assertFalse(result.ok());
        assertTrue(result.text().contains("not available"));
    }

    private static AgentToolContext context(SubagentManager manager) {
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), WorkflowModel::new,
                (level, what, detail) -> true, entry -> {});
        context.setSubagentManager(manager);
        return context;
    }

    private static AgentToolRegistry registry() {
        AgentToolRegistry registry = new AgentToolRegistry();
        SubagentTools.register(registry);
        return registry;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> subagent(AgentToolResult result) {
        return (Map<String, Object>) result.data().get("subagent");
    }
}
