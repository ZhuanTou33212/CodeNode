package local.codenode.agent.tools;

import local.codenode.agent.AgentSessionScope;

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
        if (context != null && !context.systemEnabled()) {
            return AgentToolResult.error("Agent 工具总开关已关闭（agent.permissions system:disabled）");
        }
        RegisteredTool tool = tools.get(name);
        if (tool == null) return AgentToolResult.error("未知工具：" + name);
        try {
            Map<String, Object> actual = arguments == null ? Map.of() : arguments;
            String validation = validate(tool.spec().inputSchema(), actual);
            if (validation != null) return AgentToolResult.error("工具参数无效：" + validation);
            return tool.executor().execute(context, actual);
        } catch (Exception e) {
            return AgentToolResult.error("工具 " + name + " 执行失败：" + e.getMessage());
        }
    }

    /**
     * 显式指定会话作用域执行工具（P2-8）：跨线程调用点（MCP bridge、子代理等）
     * 传入调用方的 {@code AgentSessionScope}，由 context 在执行期间绑定，
     * 不依赖 ThreadLocal 恰好已绑定；scope 为 null 时等价于无 scope 版本（共享兜底）。
     */
    public AgentToolResult execute(String name, Map<String, Object> arguments, AgentToolContext context, AgentSessionScope scope) {
        if (scope == null) return execute(name, arguments, context);
        return context.runWithScope(scope, () -> execute(name, arguments, context));
    }

    private static String validate(Map<String, Object> schema, Map<String, Object> arguments) {
        if (schema == null || schema.isEmpty()) return null;
        Object required = schema.get("required");
        if (required instanceof List<?> list) {
            for (Object item : list) {
                String key = String.valueOf(item);
                if (!arguments.containsKey(key) || arguments.get(key) == null
                        || arguments.get(key) instanceof String s && s.isBlank()) return "缺少必填参数 " + key;
            }
        }
        Object rawProperties = schema.get("properties");
        if (!(rawProperties instanceof Map<?, ?> properties)) return null;
        for (Map.Entry<String, Object> entry : arguments.entrySet()) {
            Object raw = properties.get(entry.getKey());
            if (!(raw instanceof Map<?, ?> property) || entry.getValue() == null) continue;
            String type = String.valueOf(property.get("type"));
            Object value = entry.getValue();
            boolean valid = switch (type) {
                case "string" -> value instanceof String;
                case "integer" -> value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long;
                case "number" -> value instanceof Number;
                case "boolean" -> value instanceof Boolean;
                case "array" -> value instanceof List<?>;
                case "object" -> value instanceof Map<?, ?>;
                default -> true;
            };
            if (!valid) return "参数 " + entry.getKey() + " 应为 " + type;
        }
        return null;
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
