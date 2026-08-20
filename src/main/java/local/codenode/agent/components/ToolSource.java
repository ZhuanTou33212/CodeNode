package local.codenode.agent.components;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.config.AgentConfig;

import java.io.IOException;

/**
 * 工具来源组件（对应 DeepSeek Harness 的 tool / mcp 插件）。
 *
 * <p>每个实现向同一个 {@link AgentToolRegistry} 注册一组工具；通过
 * {@code tools.sources} 配置选择启用的来源（内置 {@code builtin} 与
 * {@code mcp}），第三方可注册自定义实现，无需改动 {@code AgentToolkit}。</p>
 *
 * <p>生命周期：注册失败以 {@link #warning()} 报告（不中断装配）；
 * 持有子进程/连接等资源的实现重写 {@link #close()}，由
 * {@link HarnessComponents#close()} 统一释放。</p>
 */
public interface ToolSource {

    /** 配置里引用的来源名（如 {@code builtin} / {@code mcp}）。 */
    String name();

    /** 把本来源的工具注册进注册表。 */
    void registerInto(AgentToolRegistry registry) throws IOException;

    /** 释放持有的资源（MCP client 等）；无资源时无需重写。 */
    default void close() {
    }

    /** 非致命警告（如某个 MCP server 连接失败）；无警告返回空串。 */
    default String warning() {
        return "";
    }

    /** 工具源工厂（装配时按需创建，可持有配置）。 */
    @FunctionalInterface
    interface Factory {
        ToolSource create(AgentToolContext toolContext, AgentConfig config);
    }
}
