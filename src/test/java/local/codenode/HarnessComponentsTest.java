package local.codenode;

import local.codenode.agent.components.HarnessAssembler;
import local.codenode.agent.components.HarnessComponents;
import local.codenode.agent.components.PromptSection;
import local.codenode.agent.MessageHistory;
import local.codenode.agent.components.SessionStore;
import local.codenode.agent.AgentChatController;
import local.codenode.agent.ChatClient;
import local.codenode.agent.ChatEvent;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class HarnessComponentsTest {

    @Test
    void defaultsEnableTheBuiltInHarness() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);

        HarnessComponents components = HarnessAssembler.assembleDefaults(config, context);
        try {
            assertEquals(HarnessAssembler.DEFAULT_COMPONENTS, config.harnessComponents());
            assertTrue(components.tools().contains("read_file"));
            assertEquals(List.of("role", "file_rules", "scan_rules", "knowledge_rules",
                    "project_memory", "user_memory", "knowledge_state", "tasks", "agent_info", "extra"),
                    components.promptAssembler().sectionNames());
            assertEquals(3, components.planCheckInterval());
            assertEquals(1, components.listeners().size());
        } finally {
            components.close();
        }
    }

    @Test
    void componentCategoriesAndPromptSectionsAreConfigurable() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-config-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        config.setHarnessComponents(List.of("prompt"));
        config.setPromptSections(List.of("extra", "role"));
        config.setPlanCheckInterval(0);
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);

        HarnessComponents components = HarnessAssembler.assembleDefaults(config, context);
        try {
            assertNull(components.client());
            assertFalse(components.tools().contains("read_file"));
            assertEquals(List.of("extra", "role"), components.promptAssembler().sectionNames());
            assertEquals(0, components.planCheckInterval());
            assertTrue(components.listeners().isEmpty());
        } finally {
            components.close();
        }
    }

    @Test
    void customPromptSectionCanBeRegisteredAndSelectedFromConfig() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-custom-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        config.setPromptSections(List.of("custom"));
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);

        HarnessComponents components = new HarnessAssembler()
                .registerPromptSection("custom", PromptSection.of("custom", ignored -> "custom prompt\\n"))
                .assemble(config, context);
        try {
            assertEquals(List.of("custom"), components.promptAssembler().sectionNames());
            assertTrue(String.valueOf(components.promptAssembler().render(
                    new local.codenode.agent.components.PromptContext(config, components.tools(), context)).get("content"))
                    .contains("custom prompt"));
        } finally {
            components.close();
        }
    }

    @Test
    void storageComponentCanUseAnInMemoryBackend() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-storage-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        config.setSessionStore("memory");
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);
        HarnessComponents components = HarnessAssembler.assembleDefaults(config, context);
        try {
            SessionStore store = components.sessionStore();
            MessageHistory writer = new MessageHistory(context, null, 128_000, store);
            writer.add(java.util.Map.of("role", "user", "content", "persisted"));
            writer.saveSessionFile(root, "s1");

            MessageHistory reader = new MessageHistory(context, null, 128_000, store);
            reader.loadSessionFile(root, "s1");
            assertEquals("persisted", reader.nonSystemMessages().get(0).get("content"));
            assertFalse(Files.exists(root.resolve(".codenode/agent-sessions/s1.json")));
        } finally {
            components.close();
        }
    }

    @Test
    void loopPolicyIsConfigurableAndReplaceable() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-loop-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        config.setLoopMaxRounds(2);
        config.setLoopMaxRetries(1);
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);

        HarnessComponents defaults = HarnessAssembler.assembleDefaults(config, context);
        assertEquals(2, defaults.loopPolicy().maxToolRounds());
        assertEquals(1, defaults.loopPolicy().maxToolRetries());
        defaults.close();

        HarnessComponents custom = new HarnessAssembler()
                .registerLoopPolicy("one-shot", ignored -> new local.codenode.agent.components.LoopPolicy() {
                    public int maxToolRounds() { return 1; }
                    public int maxToolRetries() { return 0; }
                    public long resolveToolTimeout(String name, java.util.Map<String, Object> args) { return 1; }
                })
                .assemble(config, context);
        try {
            config.setLoopPolicy("one-shot");
            // Re-assemble after changing the declarative selection.
            custom.close();
            custom = new HarnessAssembler()
                    .registerLoopPolicy("one-shot", ignored -> new local.codenode.agent.components.LoopPolicy() {
                        public int maxToolRounds() { return 1; }
                        public int maxToolRetries() { return 0; }
                        public long resolveToolTimeout(String name, java.util.Map<String, Object> args) { return 1; }
                    })
                    .assemble(config, context);
            assertEquals(1, custom.loopPolicy().maxToolRounds());
        } finally {
            custom.close();
        }
    }

    @Test
    void controllerRunsWithTheAssembledComposition() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-runtime-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);
        CountDownLatch idle = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<List<Map<String, Object>>> request = new java.util.concurrent.atomic.AtomicReference<>();
        ChatClient scripted = (messages, tools, events) -> {
            request.set(List.copyOf(messages));
            events.accept(ChatEvent.stream("done"));
            return Map.of("role", "assistant", "content", "done");
        };
        HarnessComponents components = new HarnessComponents(config, context, scripted,
                new AgentToolRegistry(),
                new local.codenode.agent.components.PromptAssembler(List.of(
                        PromptSection.of("custom-runtime", ignored -> "runtime custom prompt"))),
                null, List.of(), 0, List.of(), List.of());
        try {
            AgentChatController controller = new AgentChatController(config, components);
            controller.sendMessage("hello", event -> {
                if (event.kind() == local.codenode.agent.ChatEventKind.STATE
                        && event.state() == local.codenode.AgentProvider.SessionState.IDLE) {
                    idle.countDown();
                }
            });
            assertTrue(idle.await(5, TimeUnit.SECONDS));
            assertNotNull(request.get());
            assertEquals("runtime custom prompt", request.get().get(0).get("content"));
        } finally {
            components.close();
        }
    }
}
