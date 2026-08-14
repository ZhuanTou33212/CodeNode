package local.codenode;

import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.impl.AgentToolkit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

class GraphToolsIntegrationTest {
    @TempDir Path temp;

    @Test void schemasRejectWrongCallsAndStructuredResultsDriveCorrectLookup() {
        KnowledgeGraph graph = new KnowledgeGraph();
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new, (l,w,d) -> true, e -> {});
        context.setKnowledgeGraphSupplier(() -> graph);
        context.setConversationSupplier(() -> List.of(Map.of("role", "user", "content", "长期记住 AuthService 位于 src/AuthService.java")));
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        assertTrue(registry.contains("graph_query"));
        assertFalse(registry.execute("graph_query", Map.of(), context).ok());
        assertFalse(registry.execute("graph_query", Map.of("query", 42), context).ok());
        var summarized = registry.execute("graph_summarize", Map.of("includeCanvas", false), context);
        assertTrue(summarized.ok(), summarized.text());
        var queried = registry.execute("graph_query", Map.of("query", "authservice"), context);
        assertTrue(queried.ok(), queried.text());
        assertTrue(queried.data().get("matches") instanceof List<?>);
    }
    @Test void graphUpdateRequiresConfirmationWhenLongTermFactChanges() {
        KnowledgeGraph graph = new KnowledgeGraph();
        AtomicBoolean allow = new AtomicBoolean(true);
        AgentToolContext context = new AgentToolContext(() -> temp, WorkflowModel::new,
                (level, what, detail) -> allow.get(), e -> {});
        context.setKnowledgeGraphSupplier(() -> graph);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        assertTrue(registry.execute("graph_summarize", Map.of("text", "# Auth\nUse provider A", "source", "memory.md", "includeCanvas", false), context).ok());
        allow.set(false);
        var denied = registry.execute("graph_summarize", Map.of("text", "# Auth\nUse provider B", "source", "memory.md", "includeCanvas", false), context);
        assertFalse(denied.ok());
        assertTrue(denied.data().get("requiresConfirmation") instanceof Boolean);
        assertFalse(graph.pendingConflicts().isEmpty());
        allow.set(true);
        var accepted = registry.execute("graph_resolve_conflict", Map.of(
                "conflictId", graph.pendingConflicts().getFirst().conflictId(), "decision", "accept"), context);
        assertTrue(accepted.ok(), accepted.text());
        assertTrue(graph.conflicts().stream().anyMatch(item -> "accepted".equals(item.status())));
    }
}
