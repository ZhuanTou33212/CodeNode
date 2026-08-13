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
}
