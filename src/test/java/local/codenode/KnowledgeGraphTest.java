package local.codenode;

import local.codenode.agent.knowledge.ConversationGraphParser;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.knowledge.TextSummarizer;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class KnowledgeGraphTest {
    @Test void longTextBecomesLayeredDslAndIsQueryable() {
        String text = "# 登录架构\n用户通过 LoginController 登录。\n\n"
                + "## 服务层\nAuthService 调用 TokenStore.java 保存令牌。\n\n"
                + "```java\nclass AuthService { void login() {} }\n```\n" + "约束与说明。".repeat(1000);
        KnowledgeGraph graph = new ConversationGraphParser().parse(text, "画布有 Login 和 Token 两个节点", "docs/auth.md");
        assertFalse(graph.roots().isEmpty());
        assertTrue(graph.size() >= 4);
        assertTrue(graph.toDsl().contains("("));
        assertFalse(graph.query("authservice", null).isEmpty());
        KnowledgeGraph restored = KnowledgeGraph.parse(graph.toDsl());
        assertEquals(graph.size(), restored.size());
        assertFalse(restored.query("tokenstore", null).isEmpty());
    }

    @Test void hierarchyRejectsCyclesAndMultipleParents() {
        KnowledgeGraph graph = new KnowledgeGraph();
        graph.put(new KnowledgeGraph.Element("a", "a", "", java.util.List.of(), "", "", java.util.List.of()));
        graph.put(new KnowledgeGraph.Element("b", "b", "", java.util.List.of(), "", "", java.util.List.of()));
        graph.put(new KnowledgeGraph.Element("c", "c", "", java.util.List.of(), "", "", java.util.List.of()));
        graph.addRoot("a"); graph.connect("a", "b"); graph.connect("b", "c");
        assertThrows(IllegalArgumentException.class, () -> graph.connect("c", "a"));
        assertThrows(IllegalArgumentException.class, () -> graph.connect("a", "c"));
    }

    @Test void summarizerExtractsCodeEntitiesReferencesAndCamelCaseKeywords() {
        TextSummarizer.Summary summary = new TextSummarizer().summarize(
                "# Index\npackage demo; class Minecraft_sourceFile { void runTask() {} } see src/App.java");
        assertTrue(summary.entities().stream().anyMatch(v -> v.contains("Minecraft_sourceFile")));
        assertTrue(summary.refs().contains("src/App.java"));
        assertTrue(summary.keywords().contains("minecraft"));
    }

    @Test void conflictingMetadataIsRecordedAndOnlyAppliedAfterResolution() {
        KnowledgeGraph graph = new KnowledgeGraph();
        KnowledgeGraph initial = new ConversationGraphParser().parse("# Auth\nUse provider A", "", "memory.md");
        KnowledgeGraph update = new ConversationGraphParser().parse("# Auth\nUse provider B", "", "memory.md");
        graph.merge(initial);
        graph.merge(update);
        var conflicts = graph.pendingConflicts();
        assertFalse(conflicts.isEmpty());
        var resolved = graph.resolveConflict(conflicts.getFirst().conflictId(), true);
        assertEquals("accepted", resolved.status());
        assertTrue(graph.get(conflicts.getFirst().elementId()).summary().contains("provider B"));
    }
}
