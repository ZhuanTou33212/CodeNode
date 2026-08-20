package local.codenode.agent.components;

import local.codenode.agent.AnthropicChatClient;
import local.codenode.agent.AgentChatController;
import local.codenode.agent.ChatClient;
import local.codenode.agent.LlmConversationSummarizer;
import local.codenode.agent.OpenAiChatClient;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.config.AgentConfig;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceConfigurationError;
import java.util.ServiceLoader;

/**
 * harness 组件装配器（对应 DeepSeek Harness 的 cordis 插件装配：一切皆组件，
 * 配置驱动选择与组装）。
 *
 * <p>组件类别（{@code harness.components}，逗号分隔，缺省全部启用）：</p>
 * <ul>
 *   <li>{@code llm} — LLM 后端，按 {@code api_provider} 从注册表选
 *       {@link ChatClientFactory}（内置 openai / anthropic），统一套重试退避装饰器；</li>
 *   <li>{@code tools} — 工具来源，按 {@code tools.sources} 依次注册
 *       {@link ToolSource}（内置 builtin / mcp），最后统一白名单过滤；</li>
 *   <li>{@code prompt} — 系统提示分段，按 {@code harness.prompt_sections}
 *       选择/排序 {@link PromptSection}（内置 10 段）；</li>
 *   <li>{@code compactor} — 会话摘要压缩策略，按 {@code harness.compactor}
 *       选 {@link CompactorFactory}（auto / local / llm / none）；</li>
 *   <li>{@code storage} — 会话持久化，按 {@code harness.storage} 选择
 *       {@link SessionStore.Factory}（file / memory）；</li>
 *   <li>{@code loop} — agent loop 策略，按 {@code harness.loop} 选择
 *       {@link LoopPolicy.Factory}（default）；</li>
 *   <li>{@code listeners} — 事件监听器，按 {@code harness.listeners} 装配
 *       {@link HarnessListener}（内置 trace）；</li>
 *   <li>{@code planner} — 规划层，{@code harness.plan_check_interval} 步注入一次进度检查。</li>
 * </ul>
 *
 * <p>第三方扩展：通过 {@link HarnessExtension} 的 ServiceLoader 或
 * {@link #registerChatClientFactory} / {@link #registerToolSource} /
 * {@link #registerPromptSection} / {@link #registerCompactor} /
 * {@link #registerSessionStore} / {@link #registerLoopPolicy} /
 * {@link #registerHarnessListener} 注册自定义组件后，
 * 配置里引用组件名即可，无需改动 {@link AgentChatController} 与 {@code AgentToolkit}。</p>
 */
public final class HarnessAssembler {

    public static final String CATEGORY_LLM = "llm";
    public static final String CATEGORY_TOOLS = "tools";
    public static final String CATEGORY_PROMPT = "prompt";
    public static final String CATEGORY_COMPACTOR = "compactor";
    public static final String CATEGORY_STORAGE = "storage";
    public static final String CATEGORY_LOOP = "loop";
    public static final String CATEGORY_LISTENERS = "listeners";
    public static final String CATEGORY_PLANNER = "planner";

    /** 默认启用的组件类别（与改造前行为一致）。 */
    public static final List<String> DEFAULT_COMPONENTS = List.of(
            CATEGORY_LLM, CATEGORY_PROMPT, CATEGORY_TOOLS, CATEGORY_COMPACTOR, CATEGORY_STORAGE, CATEGORY_LOOP,
            CATEGORY_LISTENERS, CATEGORY_PLANNER);

    private final Map<String, ChatClientFactory> chatClientFactories = new LinkedHashMap<>();
    private final Map<String, ToolSource.Factory> toolSourceFactories = new LinkedHashMap<>();
    private final Map<String, PromptSection> promptSections = new LinkedHashMap<>();
    private final Map<String, CompactorFactory> compactorFactories = new LinkedHashMap<>();
    private final Map<String, SessionStore.Factory> sessionStoreFactories = new LinkedHashMap<>();
    private final Map<String, LoopPolicy.Factory> loopPolicyFactories = new LinkedHashMap<>();
    private final Map<String, HarnessListener.Factory> listenerFactories = new LinkedHashMap<>();
    private final List<String> extensionWarnings = new ArrayList<>();

    public HarnessAssembler() {
        registerDefaults();
    }

    public HarnessAssembler registerChatClientFactory(String name, ChatClientFactory factory) {
        chatClientFactories.put(name, factory);
        return this;
    }

    public HarnessAssembler registerToolSource(String name, ToolSource.Factory factory) {
        toolSourceFactories.put(name, factory);
        return this;
    }

    /** 注册或覆盖一个系统提示分段组件；配置通过 harness.prompt_sections 引用名称。 */
    public HarnessAssembler registerPromptSection(String name, PromptSection section) {
        promptSections.put(name, section);
        return this;
    }

    public HarnessAssembler registerCompactor(String name, CompactorFactory factory) {
        compactorFactories.put(name, factory);
        return this;
    }

    public HarnessAssembler registerSessionStore(String name, SessionStore.Factory factory) {
        sessionStoreFactories.put(name, factory);
        return this;
    }

    public HarnessAssembler registerLoopPolicy(String name, LoopPolicy.Factory factory) {
        loopPolicyFactories.put(name, factory);
        return this;
    }

    public HarnessAssembler registerHarnessListener(String name, HarnessListener.Factory factory) {
        listenerFactories.put(name, factory);
        return this;
    }

    /** 加载 classpath 上的第三方 harness 扩展；扩展失败不会阻断内置组件启动。 */
    public HarnessAssembler loadExtensions() {
        try {
            for (HarnessExtension extension : ServiceLoader.load(HarnessExtension.class)) {
                try {
                    extension.register(this);
                } catch (RuntimeException failure) {
                    extensionWarnings.add("harness 扩展 " + extension.name() + " 加载失败："
                            + (failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage()));
                }
            }
        } catch (ServiceConfigurationError failure) {
            extensionWarnings.add("harness 扩展发现失败：" + failure.getMessage());
        }
        return this;
    }

    private void registerDefaults() {
        chatClientFactories.put("openai", config -> new OpenAiChatClient(config));
        chatClientFactories.put("anthropic", config -> new AnthropicChatClient(config));
        toolSourceFactories.put("builtin", (ctx, config) -> new BuiltinToolSource());
        toolSourceFactories.put("mcp", (ctx, config) -> new McpToolSource(config));
        promptSections.putAll(PromptSections.builtin());
        compactorFactories.put("auto", (config, client) ->
                config.llmSummaryEnabled() && client != null ? new LlmConversationSummarizer(client) : null);
        compactorFactories.put("llm", (config, client) ->
                client == null ? null : new LlmConversationSummarizer(client));
        compactorFactories.put("local", (config, client) -> null);
        compactorFactories.put("none", (config, client) -> null);
        sessionStoreFactories.put("file", (config, context) -> new FileSessionStore());
        sessionStoreFactories.put("memory", (config, context) -> new MemorySessionStore());
        loopPolicyFactories.put("default", DefaultLoopPolicy::new);
        listenerFactories.put("trace", TraceHarnessListener::new);
    }

    /**
     * 按配置装配全部组件。永不抛出 IOException：工具源连接失败转为警告，
     * 汇总进 {@link HarnessComponents#warnings()}。
     */
    public HarnessComponents assemble(AgentConfig config, AgentToolContext toolContext) {
        List<String> enabled = config.harnessComponents();
        List<String> warnings = new ArrayList<>(extensionWarnings);
        for (String category : enabled) {
            if (!DEFAULT_COMPONENTS.contains(category)) {
                warnings.add("harness.components 引用了未知组件类别：" + category);
            }
        }

        ChatClientFactory clientFactory = null;
        if (enabled.contains(CATEGORY_LLM)) {
            ChatClientFactory factory = chatClientFactories.get(config.apiProvider());
            if (factory == null) {
                warnings.add("llm 组件：未注册的 api_provider '" + config.apiProvider() + "'，回退 openai");
                factory = chatClientFactories.get("openai");
            }
            clientFactory = factory;
        }

        AgentToolRegistry tools = new AgentToolRegistry();
        List<ToolSource> sources = new ArrayList<>();
        if (enabled.contains(CATEGORY_TOOLS)) {
            for (String name : config.toolsSources()) {
                ToolSource.Factory factory = toolSourceFactories.get(name);
                if (factory == null) {
                    warnings.add("tools.sources 引用了未注册的工具源：" + name);
                    continue;
                }
                ToolSource source = factory.create(toolContext, config);
                try {
                    source.registerInto(tools);
                } catch (IOException e) {
                    warnings.add("工具源 " + name + " 注册失败：" + e.getMessage());
                }
                sources.add(source);
                if (!source.warning().isBlank()) warnings.add(source.warning());
            }
        }
        AgentToolkit.filterByConfig(tools, config);

        PromptAssembler prompt = enabled.contains(CATEGORY_PROMPT)
                ? assemblePrompt(config.promptSections(), warnings)
                : PromptAssembler.empty();

        CompactorFactory compactorFactory = null;
        if (enabled.contains(CATEGORY_COMPACTOR)) {
            compactorFactory = compactorFactories.get(config.compactor());
            if (compactorFactory == null) {
                warnings.add("harness.compactor 引用了未注册的压缩器：" + config.compactor() + "，回退 auto");
                compactorFactory = compactorFactories.get("auto");
            }
            if ("llm".equals(config.compactor()) && !enabled.contains(CATEGORY_LLM)) {
                warnings.add("harness.compactor=llm 依赖 llm 组件，但 llm 当前未启用；将使用本地摘要回退");
            }
        }

        List<HarnessListener.Factory> listeners = new ArrayList<>();
        if (enabled.contains(CATEGORY_LISTENERS)) {
            for (String name : config.harnessListeners()) {
                HarnessListener.Factory factory = listenerFactories.get(name);
                if (factory == null) {
                    warnings.add("harness.listeners 引用了未注册的监听器：" + name);
                    continue;
                }
                listeners.add(factory);
            }
        }

        int planCheckInterval = enabled.contains(CATEGORY_PLANNER) ? config.planCheckInterval() : 0;

        SessionStore.Factory sessionStoreFactory;
        if (enabled.contains(CATEGORY_STORAGE)) {
            sessionStoreFactory = sessionStoreFactories.get(config.sessionStore());
            if (sessionStoreFactory == null) {
                warnings.add("harness.storage 引用了未注册的存储组件：" + config.sessionStore() + "，回退 file");
                sessionStoreFactory = sessionStoreFactories.get("file");
            }
        } else {
            sessionStoreFactory = sessionStoreFactories.get("memory");
        }

        LoopPolicy.Factory loopPolicyFactory = loopPolicyFactories.get(config.loopPolicy());
        if (loopPolicyFactory == null) {
            warnings.add("harness.loop 引用了未注册的 loop policy：" + config.loopPolicy() + "，回退 default");
            loopPolicyFactory = loopPolicyFactories.get("default");
        }
        if (!enabled.contains(CATEGORY_LOOP)) {
            loopPolicyFactory = loopPolicyFactories.get("default");
        }

        return new HarnessComponents(config, toolContext, null, clientFactory, tools, prompt,
                null, compactorFactory, listeners, planCheckInterval, sources, warnings,
                null, sessionStoreFactory, loopPolicyFactory);
    }

    private PromptAssembler assemblePrompt(List<String> names, List<String> warnings) {
        List<PromptSection> selected = new ArrayList<>();
        for (String name : names) {
            PromptSection section = promptSections.get(name);
            if (section == null) {
                warnings.add("harness.prompt_sections 引用了未注册的提示词组件：" + name);
                continue;
            }
            selected.add(section);
        }
        return new PromptAssembler(selected);
    }

    /** 默认注册表装配（应用入口）。 */
    public static HarnessComponents assembleDefaults(AgentConfig config, AgentToolContext toolContext) {
        return new HarnessAssembler().loadExtensions().assemble(config, toolContext);
    }
}
