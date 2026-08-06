package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.util.Map;

/** save_project：保存当前工程（.cnode）。 */
public final class SaveProjectTool {

    private SaveProjectTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "save_project",
            "保存当前工程（.cnode）到磁盘。",
            Map.of("type", "object", "properties", Map.of()),
            SaveProjectTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        context.saveProject();
        return AgentToolResult.ok("已提交保存当前工程");
    }
}
