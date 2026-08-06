package local.codenode.agent.tools;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 工具注册表：register / unregister / listTools / execute。
 * 内嵌 Agent 默认本地直调工具，不走 MCP；可选通过 CodeNodeMcpServer.registerToolBridge 暴露为 MCP。
 */
public final class AgentToolRegistry {
    private record RegisteredTool(AgentToolSpec spec, ToolExecutor executor) {}

    private final Map<String, RegisteredTool> tools = new LinkedHashMap<>();

    public AgentToolRegistry register(String name, String description, Map<String, Object> inputSchema, ToolExecutor executor) {
        Objects.requireNonNull(name, "tool name");
        tools.put(name, new RegisteredTool(new AgentToolSpec(name, description, inputSchema), executor));
        return this;
    }

    public void unregister(String name) {
        tools.remove(name);
    }

    public List<AgentToolSpec> listTools() {
        return tools.values().stream().map(RegisteredTool::spec).toList();
    }

    public boolean contains(String name) {
        return tools.containsKey(name);
    }

    public AgentToolResult execute(String name, Map<String, Object> arguments, AgentToolContext context) {
        RegisteredTool tool = tools.get(name);
        if (tool == null) return AgentToolResult.error("未知工具：" + name);
        try {
            return tool.executor().execute(context, arguments == null ? Map.of() : arguments);
        } catch (Exception e) {
            return AgentToolResult.error("工具 " + name + " 执行失败：" + e.getMessage());
        }
    }

    /** 转换为 OpenAI chat.completions 的 tools 参数。 */
    public List<Map<String, Object>> toOpenAiTools() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (RegisteredTool tool : tools.values()) {
            Map<String, Object> function = new LinkedHashMap<>();
            function.put("name", tool.spec().name());
            function.put("description", tool.spec().description());
            function.put("parameters", tool.spec().inputSchema() == null ? Map.of("type", "object", "properties", Map.of()) : tool.spec().inputSchema());
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("type", "function");
            entry.put("function", function);
            result.add(entry);
        }
        return result;
    }
}
