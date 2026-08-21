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
            assertEquals("default", components.profile().name());
            assertTrue(components.cordisRuntime().mountedPluginIds().contains("harness.sandbox"));
            assertTrue(components.cordisRuntime().mountedPluginIds().contains("harness.session-events"));
            assertNotNull(components.cordisRuntime().context().get("harness.tools"));
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
    void wholeAgentLoopIsReplaceableThroughCordisService() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-agent-loop-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        config.setAgentLoop("marker");
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);
        java.util.concurrent.atomic.AtomicBoolean invoked = new java.util.concurrent.atomic.AtomicBoolean();
        HarnessComponents components = new HarnessAssembler()
                .registerAgentLoop("marker", ignored -> task -> {
                    invoked.set(true);
                    task.run();
                })
                .assemble(config, context);
        try {
            components.agentLoop().run(() -> { });
            assertTrue(invoked.get());
        } finally {
            components.close();
        }
    }

    @Test
    void sessionScopedCordisEventsArePersistedByTheBoundStore() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-events-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);
        HarnessComponents components = HarnessAssembler.assembleDefaults(config, context);
        local.codenode.agent.components.SessionEventStore store =
                new local.codenode.agent.components.MemorySessionEventStore();
        AutoCloseable binding = components.bindSession("s1", store);
        try {
            components.emit(new local.codenode.agent.cordis.CordisEvent("agent/request", "s1",
                    java.time.Instant.now(), Map.of("messages", List.of())));
            assertEquals(List.of("agent/request"), store.read(root, "s1").stream()
                    .map(local.codenode.agent.components.SessionEvent::type).toList());
            assertTrue(store.read(root, "other").isEmpty());
        } finally {
            binding.close();
            components.close();
        }
    }

    @Test
    void configuredCordisPluginIsMountedIntoTheProfile() throws Exception {
        Path root = Files.createTempDirectory("codenode-harness-configured-plugin-");
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        config.setCordisPlugins(List.of(ConfiguredPlugin.class.getName()));
        AgentToolContext context = new AgentToolContext(() -> root, () -> null, null, null);
        HarnessComponents components = HarnessAssembler.assembleDefaults(config, context);
        try {
            assertEquals("configured", components.cordisRuntime().context().get("test.configured"));
            assertTrue(components.cordisRuntime().mountedPluginIds().contains("test.configured-plugin"));
        } finally {
            components.close();
        }
    }

    public static final class ConfiguredPlugin implements local.codenode.agent.cordis.CordisPlugin {
        public ConfiguredPlugin() { }
        @Override public String id() { return "test.configured-plugin"; }
        @Override public void apply(local.codenode.agent.cordis.CordisContext context) {
            context.provide("test.configured", "configured");
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
