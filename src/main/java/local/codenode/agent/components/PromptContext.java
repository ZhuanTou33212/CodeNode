package local.codenode.agent.components;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.config.AgentConfig;

/**
 * 系统提示渲染上下文：分段组件渲染时所需的动态数据
 * （配置、已装配工具列表、工具执行上下文）。
 */
public record PromptContext(AgentConfig config, AgentToolRegistry tools, AgentToolContext toolContext) {

    public static PromptContext of(AgentConfig config, AgentToolRegistry tools, AgentToolContext toolContext) {
        return new PromptContext(config, tools, toolContext);
    }
}
