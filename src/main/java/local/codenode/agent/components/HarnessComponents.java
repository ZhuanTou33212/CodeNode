package local.codenode.agent.components;

import local.codenode.agent.ChatClient;
import local.codenode.agent.ConversationSummarizer;
import local.codenode.agent.RetryingChatClient;
import local.codenode.agent.cordis.CordisEvent;
import local.codenode.agent.cordis.CordisEventBus;
import local.codenode.agent.cordis.CordisPlugin;
import local.codenode.agent.cordis.CordisRuntime;
import local.codenode.agent.cordis.CordisProfile;
import local.codenode.agent.cordis.CordisScope;
import local.codenode.agent.cordis.AgentUiBridge;
import local.codenode.agent.cordis.DefaultSchedulerService;
import local.codenode.agent.cordis.DefaultSkillRegistry;
import local.codenode.agent.cordis.ProjectSandboxService;
import local.codenode.agent.cordis.SandboxService;
import local.codenode.agent.cordis.SchedulerService;
import local.codenode.agent.cordis.SkillRegistry;
import local.codenode.agent.cordis.UiBridge;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.config.AgentConfig;

import java.util.Map;
import java.util.List;
import java.util.ArrayList;
import java.util.Set;

/**
 * harness 装配结果：一次配置驱动的组件装配产出的完整运行单元
 * （对应 DeepSeek Harness 一次 cordis 配置实例化的 agent 服务集合）。
 *
 * <p>字段语义：{@code client} 可为 null（llm 组件未启用，控制器会拒绝发送）；
 * {@code compactor} 可为 null（本地规则版摘要）；{@code planCheckInterval}
 * 为 0 表示 planner 组件未启用（不注入进度检查）；{@code toolSources}
 * 由 {@link #close()} 统一释放（MCP client 等）；{@code sessionStore} 为每个会话提供
 * 可替换的持久化后端。</p>
 */
public final class HarnessComponents {

    private final AgentConfig config;
    private final AgentToolContext toolContext;
    private final ChatClient client;
    private final ChatClientFactory clientFactory;
    private final AgentToolRegistry tools;
    private final PromptAssembler promptAssembler;
    private final ConversationSummarizer compactor;
    private final CompactorFactory compactorFactory;
    private final SessionStore sessionStore;
    private final SessionStore.Factory sessionStoreFactory;
    private final LoopPolicy.Factory loopPolicyFactory;
    private final List<HarnessListener.Factory> listenerFactories;
    private final int planCheckInterval;
    private final List<ToolSource> toolSources;
    private volatile List<String> warnings;
    private final SessionEventStore sessionEventStore;
    private final SessionEventStore.Factory sessionEventStoreFactory;
    private final CordisRuntime cordisRuntime;
    private CordisProfile profile;
    private final SandboxService sandbox;
    private final UiBridge ui;
    private final SchedulerService scheduler;
    private final SkillRegistry skills;
    private final AgentLoop agentLoop;
    private final AgentSpawner agentSpawner;

    public HarnessComponents(AgentConfig config, AgentToolContext toolContext, ChatClient client,
                             AgentToolRegistry tools, PromptAssembler promptAssembler,
                             ConversationSummarizer compactor, List<HarnessListener.Factory> listenerFactories,
                             int planCheckInterval, List<ToolSource> toolSources, List<String> warnings) {
        this(config, toolContext, client, null, tools, promptAssembler, compactor, null,
                listenerFactories, planCheckInterval, toolSources, warnings,
                new FileSessionStore(), null, null, new FileSessionEventStore(), null);
    }

    HarnessComponents(AgentConfig config, AgentToolContext toolContext, ChatClient client,
                      ChatClientFactory clientFactory, AgentToolRegistry tools, PromptAssembler promptAssembler,
                      ConversationSummarizer compactor, CompactorFactory compactorFactory,
                      List<HarnessListener.Factory> listenerFactories, int planCheckInterval,
                      List<ToolSource> toolSources, List<String> warnings,
                      SessionStore sessionStore, SessionStore.Factory sessionStoreFactory,
                      LoopPolicy.Factory loopPolicyFactory) {
        this(config, toolContext, client, clientFactory, tools, promptAssembler, compactor, compactorFactory,
                listenerFactories, planCheckInterval, toolSources, warnings, sessionStore, sessionStoreFactory,
                loopPolicyFactory, new FileSessionEventStore(), null);
    }

    HarnessComponents(AgentConfig config, AgentToolContext toolContext, ChatClient client,
                      ChatClientFactory clientFactory, AgentToolRegistry tools, PromptAssembler promptAssembler,
                      ConversationSummarizer compactor, CompactorFactory compactorFactory,
                      List<HarnessListener.Factory> listenerFactories, int planCheckInterval,
                      List<ToolSource> toolSources, List<String> warnings,
                      SessionStore sessionStore, SessionStore.Factory sessionStoreFactory,
                      LoopPolicy.Factory loopPolicyFactory,
                      SessionEventStore sessionEventStore, SessionEventStore.Factory sessionEventStoreFactory) {
        this.config = config;
        this.toolContext = toolContext;
        this.client = client;
        this.clientFactory = clientFactory;
        this.tools = tools;
        this.promptAssembler = promptAssembler == null ? PromptAssembler.defaultAssembler() : promptAssembler;
        this.compactor = compactor;
        this.compactorFactory = compactorFactory;
        this.sessionStore = sessionStore;
        this.sessionStoreFactory = sessionStoreFactory;
        this.loopPolicyFactory = loopPolicyFactory;
        this.listenerFactories = listenerFactories == null ? List.of() : List.copyOf(listenerFactories);
        this.planCheckInterval = planCheckInterval;
        this.toolSources = toolSources == null ? List.of() : List.copyOf(toolSources);
        this.warnings = warnings == null ? List.of() : List.copyOf(warnings);
        this.sessionEventStore = sessionEventStore;
        this.sessionEventStoreFactory = sessionEventStoreFactory;
        this.sandbox = new ProjectSandboxService(toolContext::projectRoot);
        this.ui = new AgentUiBridge(toolContext);
        this.scheduler = new DefaultSchedulerService();
        this.skills = new DefaultSkillRegistry();
        this.agentLoop = new DefaultAgentLoop();
        this.agentSpawner = runner -> new local.codenode.agent.SubagentManager(runner);
        this.cordisRuntime = new CordisRuntime();
        try {
            List<CordisPlugin> plugins = new ArrayList<>();
            plugins.add(new ServicePlugin("harness.config", Set.of(), "harness.config", this.config));
            plugins.add(new ServicePlugin("harness.context", Set.of("harness.config"),
                    "harness.context", this.toolContext));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_LLM,
                    new ServicePlugin("harness.llm", Set.of("harness.config"), "harness.llm",
                            this.clientFactory == null ? (ChatClientFactory) ignored -> this.client : this.clientFactory));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_TOOLS,
                    new ServicePlugin("harness.tools", Set.of("harness.config"), "harness.tools", this.tools));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_PROMPT,
                    new ServicePlugin("harness.prompt", Set.of("harness.config"), "harness.prompt", this.promptAssembler));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_COMPACTOR,
                    new ServicePlugin("harness.compactor", Set.of("harness.config"), "harness.compactor",
                            this.compactorFactory == null ? (CompactorFactory) (ignored, unused) -> this.compactor : this.compactorFactory));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_STORAGE,
                    new ServicePlugin("harness.session-store", Set.of("harness.config"), "harness.session-store",
                            this.sessionStoreFactory == null ? (SessionStore.Factory) (ignored, unused) -> this.sessionStore : this.sessionStoreFactory));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_SESSION_EVENTS,
                    new ServicePlugin("harness.session-events", Set.of("harness.config"), "harness.session-events",
                            this.sessionEventStoreFactory == null ? (SessionEventStore.Factory) (ignored, unused) -> this.sessionEventStore : this.sessionEventStoreFactory));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_LOOP,
                    new ServicePlugin("harness.loop", Set.of("harness.config"), "harness.loop",
                            this.loopPolicyFactory == null ? (LoopPolicy.Factory) DefaultLoopPolicy::new : this.loopPolicyFactory));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_AGENT_LOOP,
                    new ServicePlugin("harness.agent-loop", Set.of("harness.config"), "harness.agent-loop", this.agentLoop));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_AGENTS,
                    new ServicePlugin("harness.agents", Set.of("harness.config"), "harness.agents", this.agentSpawner));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_LISTENERS,
                    new ServicePlugin("harness.listeners", Set.of("harness.config"), "harness.listeners", this.listenerFactories));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_PLANNER,
                    new ServicePlugin("harness.planner", Set.of("harness.config"), "harness.planner", this.planCheckInterval));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_SANDBOX,
                    new ServicePlugin("harness.sandbox", Set.of("harness.config"), "harness.sandbox", this.sandbox));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_UI,
                    new ServicePlugin("harness.ui", Set.of("harness.config"), "harness.ui", this.ui));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_SCHEDULER,
                    new ServicePlugin("harness.scheduler", Set.of("harness.config"), "harness.scheduler", this.scheduler));
            addIfEnabled(plugins, HarnessAssembler.CATEGORY_SKILLS,
                    new ServicePlugin("harness.skills", Set.of("harness.config"), "harness.skills", this.skills));
            this.profile = new CordisProfile(config.harnessProfile(), plugins);
            this.profile.mount(this.cordisRuntime);
        } catch (Exception failure) {
            this.cordisRuntime.close();
            throw new IllegalStateException("cannot mount harness capability plugins", failure);
        }
    }

    private void addIfEnabled(List<CordisPlugin> plugins, String category, CordisPlugin plugin) {
        if (config.harnessComponents().contains(category)) plugins.add(plugin);
    }

    public AgentConfig config() {
        return config;
    }

    public AgentToolContext toolContext() {
        return toolContext;
    }

    /** LLM 后端（llm 组件未启用时为 null）。 */
    public ChatClient client() {
        return client != null ? client : createClient();
    }

    /** 为一个会话创建独立的 LLM client，避免多标签共享 abort/连接状态。 */
    public ChatClient createClient() {
        if (clientFactory != null) {
            ChatClientFactory factory = service("harness.llm", ChatClientFactory.class, clientFactory);
            return new RetryingChatClient(factory.create(config));
        }
        return client;
    }

    /** 已装配的工具注册表（全部启用的工具源 + 白名单过滤后）。 */
    public AgentToolRegistry tools() {
        return service("harness.tools", AgentToolRegistry.class, tools);
    }

    /** 系统提示装配器。 */
    public PromptAssembler promptAssembler() {
        return service("harness.prompt", PromptAssembler.class, promptAssembler);
    }

    /** 会话摘要压缩策略（可为 null=本地规则版）。 */
    public ConversationSummarizer compactor() {
        return compactor != null ? compactor : createCompactor(client());
    }

    /** 为一个会话创建独立的压缩器。 */
    public ConversationSummarizer createCompactor(ChatClient sessionClient) {
        CompactorFactory factory = service("harness.compactor", CompactorFactory.class, compactorFactory);
        return factory == null ? compactor : factory.create(config, sessionClient);
    }

    /** 为一个会话创建存储组件。 */
    public SessionStore sessionStore() {
        SessionStore.Factory factory = service("harness.session-store", SessionStore.Factory.class, sessionStoreFactory);
        return factory == null ? sessionStore : factory.create(config, toolContext);
    }

    /** Creates the append-only trajectory store for a session. */
    public SessionEventStore sessionEventStore() {
        SessionEventStore.Factory factory = service("harness.session-events", SessionEventStore.Factory.class,
                sessionEventStoreFactory);
        return factory == null ? sessionEventStore : factory.create(config, toolContext);
    }

    public SandboxService sandbox() { return service("harness.sandbox", SandboxService.class, sandbox); }
    public UiBridge ui() { return service("harness.ui", UiBridge.class, ui); }
    public SchedulerService scheduler() { return service("harness.scheduler", SchedulerService.class, scheduler); }
    public SkillRegistry skills() { return service("harness.skills", SkillRegistry.class, skills); }
    public AgentLoop agentLoop() { return service("harness.agent-loop", AgentLoop.class, agentLoop); }
    public AgentSpawner agentSpawner() { return service("harness.agents", AgentSpawner.class, agentSpawner); }

    /** Cordis runtime backing this harness composition. */
    public CordisRuntime cordisRuntime() {
        return cordisRuntime;
    }

    public CordisProfile profile() { return profile; }

    public CordisScope openSessionScope(String sessionId) {
        return cordisRuntime.openScope(sessionId);
    }

    /** Emits an event to all mounted Cordis plugins. */
    public CordisEvent emit(CordisEvent event) {
        return cordisRuntime.context().events().emit(event);
    }

    /**
     * Binds one session's durable trajectory to the shared event bus. Events
     * from other sessions remain isolated by their Cordis scope.
     */
    public AutoCloseable bindSession(String sessionId, SessionEventStore store) {
        if (sessionId == null || sessionId.isBlank()) throw new IllegalArgumentException("sessionId is blank");
        if (store == null) throw new IllegalArgumentException("session event store is null");
        java.nio.file.Path projectRoot = toolContext.projectRoot();
        CordisEventBus.Subscription subscription = cordisRuntime.context().events().on("*", event -> {
            if (sessionId.equals(event.scope())) {
                store.append(projectRoot, sessionId, event.type(), event.fields());
            }
        });
        return subscription;
    }

    /** Mounts third-party Cordis plugins after the built-in capability tree. */
    public void mountPlugins(List<? extends CordisPlugin> plugins) {
        if (plugins == null || plugins.isEmpty()) return;
        try {
            cordisRuntime.mountAll(plugins);
        } catch (Exception failure) {
            throw new IllegalStateException("cannot mount Cordis extension plugins", failure);
        }
    }

    /** Replaces the whole-turn driver in the live Cordis service tree. */
    public void replaceAgentLoop(AgentLoop replacement) {
        if (replacement == null || !config.harnessComponents().contains(HarnessAssembler.CATEGORY_AGENT_LOOP)) return;
        try {
            cordisRuntime.replace(new ServicePlugin("harness.agent-loop", Set.of("harness.config"),
                    "harness.agent-loop", replacement));
        } catch (Exception failure) {
            throw new IllegalStateException("cannot replace Agent loop", failure);
        }
    }

    /** Replaces the subagent factory in the live Cordis service tree. */
    public void replaceAgentSpawner(AgentSpawner replacement) {
        if (replacement == null || !config.harnessComponents().contains(HarnessAssembler.CATEGORY_AGENTS)) return;
        try {
            cordisRuntime.replace(new ServicePlugin("harness.agents", Set.of("harness.config"),
                    "harness.agents", replacement));
        } catch (Exception failure) {
            throw new IllegalStateException("cannot replace subagent service", failure);
        }
    }

    /** Adds a visible non-fatal assembly diagnostic. */
    public synchronized void addWarning(String warning) {
        if (warning == null || warning.isBlank()) return;
        List<String> next = new java.util.ArrayList<>(this.warnings);
        next.add(warning);
        // Keep the public snapshot immutable while allowing late plugin diagnostics.
        this.warnings = List.copyOf(next);
    }

    /** 为一个会话创建 loop policy。 */
    public LoopPolicy loopPolicy() {
        LoopPolicy.Factory factory = service("harness.loop", LoopPolicy.Factory.class, loopPolicyFactory);
        return factory == null ? new DefaultLoopPolicy(config) : factory.create(config);
    }

    /** 启用的 harness 监听器。 */
    public List<HarnessListener> listeners() {
        Object raw = service("harness.listeners", Object.class, listenerFactories);
        List<HarnessListener.Factory> factories = new ArrayList<>();
        if (raw instanceof List<?> list) {
            for (Object item : list) if (item instanceof HarnessListener.Factory factory) factories.add(factory);
        }
        return factories.stream().map(factory -> factory.create(toolContext)).toList();
    }

    /** 规划层进度检查间隔（0=planner 组件未启用）。 */
    public int planCheckInterval() {
        return service("harness.planner", Integer.class, planCheckInterval);
    }

    private <T> T service(String name, Class<T> type, T fallback) {
        try {
            T value = cordisRuntime.context().get(name, type);
            return value == null ? fallback : value;
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    /** 装配期非致命警告（如 MCP 连接失败）。 */
    public List<String> warnings() {
        return warnings;
    }

    /** 释放全部组件资源（MCP client 等）；退出时调用。 */
    public void close() {
        for (ToolSource source : toolSources) {
            try {
                source.close();
            } catch (RuntimeException ignored) {
            }
        }
        try { if (sessionEventStore != null) sessionEventStore.close(); } catch (RuntimeException ignored) { }
        try { scheduler().close(); } catch (RuntimeException ignored) { }
        cordisRuntime.close();
    }

    /** One capability service with a reversible registration effect. */
    private static final class ServicePlugin implements local.codenode.agent.cordis.CordisPlugin {
        private final String id;
        private final Set<String> dependencies;
        private final String serviceName;
        private final Object service;
        private local.codenode.agent.cordis.CordisContext.ServiceRegistration registration;

        private ServicePlugin(String id, Set<String> dependencies, String serviceName, Object service) {
            this.id = id;
            this.dependencies = Set.copyOf(dependencies);
            this.serviceName = serviceName;
            this.service = service;
        }

        @Override public String id() { return id; }
        @Override public Set<String> dependencies() { return dependencies; }

        @Override
        public void apply(local.codenode.agent.cordis.CordisContext context) {
            registration = context.provide(serviceName, service);
            context.events().emit(CordisEvent.of("service/available", id,
                    Map.of("plugin", id, "service", serviceName)));
        }

        @Override
        public void dispose(local.codenode.agent.cordis.CordisContext context) {
            if (registration != null) registration.close();
            registration = null;
            if (service instanceof AutoCloseable closeable) {
                try { closeable.close(); } catch (Exception ignored) { }
            }
            context.events().emit(CordisEvent.of("service/unavailable", id,
                    Map.of("plugin", id, "service", serviceName)));
        }
    }
}
