package local.codenode.agent.tools;

import java.util.Map;

/** 工具执行函数式接口。 */
@FunctionalInterface
public interface ToolExecutor {
    AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) throws Exception;
}
