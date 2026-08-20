package local.codenode.agent.components;

import local.codenode.agent.ChatClient;
import local.codenode.agent.ConversationSummarizer;
import local.codenode.config.AgentConfig;

/**
 * 会话摘要压缩策略组件工厂（对应 DeepSeek Harness 的 compaction 插件）。
 *
 * <p>内置策略：{@code auto}（{@code harness.llm_summary=true} 时用 LLM 摘要，
 * 否则本地规则版，兼容旧配置）、{@code llm}（强制 LLM 摘要，失败自动回退本地）、
 * {@code local}（本地规则版）、{@code none}（不注入 LLM 摘要器；本地规则版
 * 仍是 MessageHistory 的兜底，要完全关闭压缩请用 {@code agent.context_length=0}）。</p>
 */
@FunctionalInterface
public interface CompactorFactory {

    ConversationSummarizer create(AgentConfig config, ChatClient client);
}
