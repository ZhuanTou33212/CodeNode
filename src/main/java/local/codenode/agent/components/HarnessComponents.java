package local.codenode.agent.components;

import local.codenode.agent.ChatClient;
import local.codenode.agent.ConversationSummarizer;
import local.codenode.agent.RetryingChatClient;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.config.AgentConfig;

import java.util.List;

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
    private final List<String> warnings;

    public HarnessComponents(AgentConfig config, AgentToolContext toolContext, ChatClient client,
                             AgentToolRegistry tools, PromptAssembler promptAssembler,
                             ConversationSummarizer compactor, List<HarnessListener.Factory> listenerFactories,
                             int planCheckInterval, List<ToolSource> toolSources, List<String> warnings) {
        this(config, toolContext, client, null, tools, promptAssembler, compactor, null,
                listenerFactories, planCheckInterval, toolSources, warnings,
                new FileSessionStore(), null, null);
    }

    HarnessComponents(AgentConfig config, AgentToolContext toolContext, ChatClient client,
                      ChatClientFactory clientFactory, AgentToolRegistry tools, PromptAssembler promptAssembler,
                      ConversationSummarizer compactor, CompactorFactory compactorFactory,
                      List<HarnessListener.Factory> listenerFactories, int planCheckInterval,
                      List<ToolSource> toolSources, List<String> warnings,
                      SessionStore sessionStore, SessionStore.Factory sessionStoreFactory,
                      LoopPolicy.Factory loopPolicyFactory) {
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
            return new RetryingChatClient(clientFactory.create(config));
        }
        return client;
    }

    /** 已装配的工具注册表（全部启用的工具源 + 白名单过滤后）。 */
    public AgentToolRegistry tools() {
        return tools;
    }

    /** 系统提示装配器。 */
    public PromptAssembler promptAssembler() {
        return promptAssembler;
    }

    /** 会话摘要压缩策略（可为 null=本地规则版）。 */
    public ConversationSummarizer compactor() {
        return compactor != null ? compactor : createCompactor(client());
    }

    /** 为一个会话创建独立的压缩器。 */
    public ConversationSummarizer createCompactor(ChatClient sessionClient) {
        return compactorFactory == null ? compactor : compactorFactory.create(config, sessionClient);
    }

    /** 为一个会话创建存储组件。 */
    public SessionStore sessionStore() {
        return sessionStoreFactory == null ? sessionStore : sessionStoreFactory.create(config, toolContext);
    }

    /** 为一个会话创建 loop policy。 */
    public LoopPolicy loopPolicy() {
        return loopPolicyFactory == null ? new DefaultLoopPolicy(config) : loopPolicyFactory.create(config);
    }

    /** 启用的 harness 监听器。 */
    public List<HarnessListener> listeners() {
        return listenerFactories.stream().map(factory -> factory.create(toolContext)).toList();
    }

    /** 规划层进度检查间隔（0=planner 组件未启用）。 */
    public int planCheckInterval() {
        return planCheckInterval;
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
    }
}
