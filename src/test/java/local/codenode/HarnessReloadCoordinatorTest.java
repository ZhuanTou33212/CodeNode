package local.codenode;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentSessionManager;
import local.codenode.agent.components.HarnessAssembler;
import local.codenode.agent.components.HarnessComponents;
import local.codenode.agent.components.HarnessReloadCoordinator;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;

class HarnessReloadCoordinatorTest {
    @Test
    void stagesNewProfileAndCommitsIdleSession(@TempDir Path root) throws Exception {
        Path configFile = root.resolve("agent.properties");
        Files.writeString(configFile, "harness.profile=default\n", StandardCharsets.UTF_8);
        AgentConfig config = new AgentConfig(configFile);
        config.reload();
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);
        HarnessComponents oldHarness = HarnessAssembler.assembleDefaults(config, context);
        AgentSessionManager manager = new AgentSessionManager(() -> new AgentChatController(config, oldHarness));
        AgentChatController oldController = manager.activeSession().controller();
        HarnessReloadCoordinator coordinator = new HarnessReloadCoordinator(config, oldHarness, manager, context);

        Files.writeString(configFile, "harness.profile=default\nharness.session_log=memory\n", StandardCharsets.UTF_8);
        HarnessReloadCoordinator.ReloadResult result = coordinator.reload();

        assertEquals(1, result.sessions().replacedImmediately());
        assertEquals(0, result.sessions().deferredUntilIdle());
        assertEquals("memory", coordinator.activeConfig().sessionEventStore());
        assertNotSame(oldController, manager.activeSession().controller());
        manager.close();
        coordinator.activeHarness().close();
    }
}
