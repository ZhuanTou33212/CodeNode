package local.codenode.agent.mcp;

import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.config.AgentConfig;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 将配置声明的外部 MCP server 工具并入内置 Agent 的工具注册表。
 *
 * <p>配置（agent.properties）：</p>
 * <pre>
 * mcp.servers=db,web            # 逗号分隔的 server 名
 * mcp.server.db=node|C:\tools\mcp-db\server.js|--port|9000   # | 分隔的命令与参数
 * </pre>
 *
 * <p>注册名默认使用远端工具原名；与内置工具冲突时自动加 {@code mcp__<server>__} 前缀。
 * 工具执行时超时上限 120 秒，失败/超时以 {@code AgentToolResult.error} 回写，由外层
 * harness 的失败自愈机制继续驱动模型换方案。</p>
 */
public final class McpToolkit {

    /** 单次远端调用的最大等待秒数。 */
    public static final long DEFAULT_CALL_TIMEOUT_MILLIS = 120_000;

    private McpToolkit() {
    }

    /** 解析 MCP server 命令行（{@code |} 分隔命令与参数，空段忽略）。 */
    public static List<String> parseCommandLine(String value) {
        List<String> result = new ArrayList<>();
        if (value == null || value.isBlank()) return result;
        for (String part : value.split("\\|")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) result.add(trimmed);
        }
        return result;
    }

    /**
     * 按配置连接全部 MCP server 并注册其工具。
     *
     * @return 已连接的 client 列表，调用方负责在退出时逐个 close
     */
    public static List<McpStdioClient> connectConfigured(AgentConfig config, AgentToolRegistry registry) throws IOException {
        List<McpStdioClient> clients = new ArrayList<>();
        List<IOException> failures = new ArrayList<>();
        for (String name : config.mcpServers()) {
            List<String> command = parseCommandLine(config.mcpServerCommand(name));
            if (command.isEmpty()) {
                failures.add(new IOException("MCP server '" + name + "' 缺少命令配置（mcp.server." + name + "）"));
                continue;
            }
            try {
                McpStdioClient client = McpStdioClient.connect(name, command, 15_000);
                List<McpStdioClient.ToolSpec> tools = client.listTools(15_000);
                int registered = registerTools(registry, client, tools, config);
                clients.add(client);
                System.err.println("[agent] MCP server '" + name + "' 已连接，注册工具 " + registered + " 个");
            } catch (IOException failure) {
                failures.add(failure);
            }
        }
        if (!failures.isEmpty()) {
            StringBuilder message = new StringBuilder();
            for (IOException failure : failures) {
                if (message.length() > 0) message.append("; ");
                message.append(failure.getMessage());
            }
            throw new IOException(message.toString());
        }
        return List.copyOf(clients);
    }

    private static int registerTools(AgentToolRegistry registry, McpStdioClient client,
                                     List<McpStdioClient.ToolSpec> tools, AgentConfig config) {
        int count = 0;
        for (McpStdioClient.ToolSpec tool : tools) {
            String name = tool.name();
            String prefixed = "mcp__" + client.name() + "__" + name;
            // 与内置工具同源的白名单过滤：原名或前缀名任一被允许才注册
            if (!config.isToolAllowed(name) && !config.isToolAllowed(prefixed)) continue;
            String registeredName = registry.contains(name) ? prefixed : name;
            registry.register(registeredName, toolDescription(client.name(), tool),
                    normalizeSchema(tool.inputSchema()), (context, arguments) -> callRemote(client, tool.name(), arguments));
            count++;
        }
        return count;
    }

    private static AgentToolResult callRemote(McpStdioClient client, String remoteName, Map<String, Object> arguments) {
        try {
            McpStdioClient.CallResult result = client.call(remoteName, arguments, DEFAULT_CALL_TIMEOUT_MILLIS);
            return result.isError()
                    ? AgentToolResult.error("MCP 工具 " + remoteName + " 返回错误：" + result.text())
                    : AgentToolResult.ok(result.text());
        } catch (IOException failure) {
            return AgentToolResult.error("MCP 工具 " + remoteName + " 调用失败：" + failure.getMessage());
        }
    }

    private static String toolDescription(String serverName, McpStdioClient.ToolSpec tool) {
        String description = tool.description() == null || tool.description().isBlank()
                ? "外部 MCP 工具（server: " + serverName + "）" : tool.description();
        return description + "（来自外部 MCP server: " + serverName + "）";
    }

    /** 归一化 inputSchema：缺失时补空的 OpenAI function parameters 骨架。 */
    private static Map<String, Object> normalizeSchema(Map<String, Object> schema) {
        if (schema == null || schema.isEmpty()) {
            return Map.of("type", "object", "properties", Map.of());
        }
        LinkedHashMap<String, Object> normalized = new LinkedHashMap<>(schema);
        normalized.putIfAbsent("type", "object");
        normalized.putIfAbsent("properties", Map.of());
        return normalized;
    }
}
