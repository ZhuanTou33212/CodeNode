package local.codenode;

import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.knowledge.ConversationGraphParser;
import local.codenode.agent.knowledge.KnowledgeGraph;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.io.InputStream;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipFile;

import static org.junit.jupiter.api.Assertions.*;

class KnowledgePersistenceTest {
    @TempDir Path temp;

    @Test void twoProjectsKeepIndependentConversationAndKnowledgeAcrossRestart() throws Exception {
        CnodeProjectCodec codec = new CnodeProjectCodec();
        Path a = save(codec, "a", "AlphaOnly", "src/Alpha.java");
        Path b = save(codec, "b", "BetaOnly", "src/Beta.java");

        assertEquals("a-session", codec.loadAgentContext(a).orElseThrow().sessionId());
        assertEquals("b-session", codec.loadAgentContext(b).orElseThrow().sessionId());
        KnowledgeGraph aGraph = codec.loadKnowledgeGraph(a);
        KnowledgeGraph bGraph = codec.loadKnowledgeGraph(b);
        assertFalse(aGraph.query("alphaonly", null).isEmpty());
        assertTrue(aGraph.query("betaonly", null).isEmpty());
        assertFalse(bGraph.query("betaonly", null).isEmpty());
        assertTrue(bGraph.query("alphaonly", null).isEmpty());

        try (ZipFile zip = new ZipFile(a.toFile(), StandardCharsets.UTF_8)) {
            assertNotNull(zip.getEntry("knowledge-graph.dsl"));
            assertNotNull(zip.getEntry("knowledge-meta.json"));
            String integrity = new String(zip.getInputStream(zip.getEntry("integrity.json")).readAllBytes(), StandardCharsets.UTF_8);
            assertTrue(integrity.contains("knowledge-graph.dsl"));
            assertTrue(integrity.contains("knowledge-meta.json"));
            String meta = new String(zip.getInputStream(zip.getEntry("knowledge-meta.json")).readAllBytes(), StandardCharsets.UTF_8);
            assertTrue(meta.contains("elementCount"));
            assertFalse(meta.contains("AlphaOnly 位于"), "临时 meta 不应保存原始或完整摘要文本");
        }
    }

    private Path save(CnodeProjectCodec codec, String id, String unique, String source) throws Exception {
        WorkflowModel model = new WorkflowModel(); model.addNode(0, 0);
        var settings = new CnodeProjectCodec.Settings(WorkflowModel.Mode.MARKDOWN, "java", "out", "docs", null, 0, 0, 1.0, null);
        var metadata = new CnodeProjectCodec.Metadata(id, id, Instant.now(), settings);
        AgentContext context = AgentContext.of(id + "-session", unique, List.of(Map.of("role", "user", "content", unique)));
        KnowledgeGraph graph = new ConversationGraphParser().parse("# " + unique + "\n" + unique + " 位于 " + source, "", source);
        Path file = temp.resolve(id + ".cnode");
        codec.save(file, model, metadata, context, new AgentInfoSnapshot(Map.of("version", "test"), Map.of()), graph);
        return file;
    }
}
