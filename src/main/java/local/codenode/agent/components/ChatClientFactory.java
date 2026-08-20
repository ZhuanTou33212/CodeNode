package local.codenode.agent.components;

import local.codenode.agent.ChatClient;
import local.codenode.config.AgentConfig;

/**
 * LLM 后端组件工厂（对应 DeepSeek Harness 的 llm 插件）。
 *
 * <p>每个实现按名称注册进 {@link HarnessAssembler}，由 {@code api_provider}
 * 配置选择（openai / anthropic）；装配时统一再套 {@code RetryingChatClient}
 * 重试退避装饰器。</p>
 */
@FunctionalInterface
public interface ChatClientFactory {

    /** 按配置创建原始（未装饰）ChatClient。 */
    ChatClient create(AgentConfig config);
}
