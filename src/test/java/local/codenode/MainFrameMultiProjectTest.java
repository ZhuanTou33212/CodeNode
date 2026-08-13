package local.codenode;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.knowledge.ConversationGraphParser;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.tools.AgentToolContext;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.swing.SwingUtilities;
import java.awt.GraphicsEnvironment;
import java.lang.reflect.Field;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class MainFrameMultiProjectTest {
    @TempDir Path temp;

    @Test void openingTwoProjectsAndSwitchingBackKeepsLiveAgentStateIsolated() throws Exception {
        Assumptions.assumeFalse(GraphicsEnvironment.isHeadless(), "Swing desktop is unavailable");
        Path alpha = project("alpha", "AlphaKnowledge");
        Path beta = project("beta", "BetaKnowledge");
        MainFrame[] holder = new MainFrame[1];
        try {
            SwingUtilities.invokeAndWait(() -> holder[0] = new MainFrame());
            MainFrame frame = holder[0];

            SwingUtilities.invokeAndWait(() -> frame.openProject(alpha));
            AgentChatController controller = field(frame, "agentChatController", AgentChatController.class);
            controller.restoreContext(AgentContext.of("alpha-live", "Alpha live",
                    List.of(Map.of("role", "user", "content", "UNSAVED_ALPHA_MESSAGE"))));
            assertFalse(toolContext(frame).knowledgeGraph().query("alphaknowledge", null).isEmpty());

            SwingUtilities.invokeAndWait(() -> frame.openProject(beta));
            assertTrue(controller.messageHistory().stream().anyMatch(m -> String.valueOf(m.get("content")).contains("BetaKnowledge")));
            assertFalse(toolContext(frame).knowledgeGraph().query("betaknowledge", null).isEmpty());
            assertTrue(toolContext(frame).knowledgeGraph().query("alphaknowledge", null).isEmpty());

            SwingUtilities.invokeAndWait(() -> frame.openProject(alpha));
            assertTrue(controller.messageHistory().stream().anyMatch(m -> String.valueOf(m.get("content")).contains("UNSAVED_ALPHA_MESSAGE")),
                    "reselecting an open tab must not reload stale disk context");
            assertFalse(toolContext(frame).knowledgeGraph().query("alphaknowledge", null).isEmpty());
            assertTrue(toolContext(frame).knowledgeGraph().query("betaknowledge", null).isEmpty());
        } finally {
            if (holder[0] != null) SwingUtilities.invokeAndWait(holder[0]::dispose);
        }
    }

    private Path project(String id, String unique) throws Exception {
        WorkflowModel model = new WorkflowModel(); model.addNode(0, 0).name = unique;
        var settings = new CnodeProjectCodec.Settings(WorkflowModel.Mode.MARKDOWN, "java", "out", "docs", null, 0, 0, 1.0, null);
        var metadata = new CnodeProjectCodec.Metadata(id, id, Instant.now(), settings);
        AgentContext context = AgentContext.of(id + "-session", unique,
                List.of(Map.of("role", "user", "content", unique + " conversation")));
        KnowledgeGraph graph = new ConversationGraphParser().parse("# " + unique + "\n" + unique + " project fact", "", id + ".md");
        Path file = temp.resolve(id + ".cnode");
        new CnodeProjectCodec().save(file, model, metadata, context,
                new AgentInfoSnapshot(Map.of("version", "test"), Map.of()), graph);
        return file;
    }

    private static AgentToolContext toolContext(MainFrame frame) throws Exception {
        return field(frame, "agentToolContext", AgentToolContext.class);
    }

    private static <T> T field(Object owner, String name, Class<T> type) throws Exception {
        Field field = owner.getClass().getDeclaredField(name); field.setAccessible(true); return type.cast(field.get(owner));
    }
}
