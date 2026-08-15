package local.codenode.agent.mcp;

import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P1 MCP client 集成测试：以 CodeNodeMcpServer 为真实 stdio 对端进程，
 * 验证握手、tools/list、tools/call 与 McpToolkit 注册链路。
 */
class McpStdioClientTest {
    @TempDir
    Path temp;

    /** 启动 CodeNodeMcpServer 作为真实 MCP stdio server 子进程。 */
    private McpStdioClient connectServer() throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classpath = System.getProperty("java.class.path");
        return McpStdioClient.connect("test-server", List.of(java, "-cp", classpath,
                "local.codenode.CodeNodeMcpServer", temp.toString()), 15_000);
    }

    @Test
    void handshakeAndListTools() throws Exception {
        try (McpStdioClient client = connectServer()) {
            List<McpStdioClient.ToolSpec> tools = client.listTools(10_000);
            assertFalse(tools.isEmpty());
            assertTrue(tools.stream().anyMatch(t -> t.name().equals("codenode_list_requests")),
                    "应列出 CodeNode server 的受限队列工具");
        }
    }

    @Test
    void callToolReturnsResult() throws Exception {
        try (McpStdioClient client = connectServer()) {
            McpStdioClient.CallResult result = client.call("codenode_list_requests", Map.of(), 10_000);
            assertFalse(result.isError(), "tools/call 不应报错: " + result.text());
            assertNotNull(result.text());
        }
    }

    @Test
    void unknownToolReturnsError() throws Exception {
        try (McpStdioClient client = connectServer()) {
            McpStdioClient.CallResult result = client.call("no_such_tool", Map.of(), 10_000);
            assertTrue(result.isError());
        }
    }

    @Test
    void toolkitRegistersRemoteToolsIntoRegistry() throws Exception {
        AgentConfig config = new AgentConfig(temp.resolve("agent.properties"));
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        Files.writeString(config.file(),
                "mcp.servers=test-server\nmcp.server.test-server="
                        + java.replace('\\', '/') + "|"
                        + "-cp|" + System.getProperty("java.class.path").replace('\\', '/') + "|"
                        + "local.codenode.CodeNodeMcpServer|" + temp,
                StandardCharsets.UTF_8);
        config.reload();
        AgentToolRegistry registry = new AgentToolRegistry();
        List<McpStdioClient> clients = McpToolkit.connectConfigured(config, registry);
        try {
            assertTrue(registry.contains("codenode_list_requests"), "远端工具应并入注册表");
            AgentToolResult result = registry.execute("codenode_list_requests", Map.of(),
                    new local.codenode.agent.tools.AgentToolContext(
                            () -> temp, () -> null, (level, what, detail) -> true, entry -> {}));
            assertTrue(result.ok(), "通过 registry 调用远端工具应成功: " + result.text());
        } finally {
            for (McpStdioClient client : clients) client.close();
        }
    }

    @Test
    void missingCommandFailsCleanly() throws Exception {
        AgentConfig config = new AgentConfig(temp.resolve("agent.properties"));
        Files.writeString(config.file(), "mcp.servers=ghost\n", StandardCharsets.UTF_8);
        config.reload();
        try {
            McpToolkit.connectConfigured(config, new AgentToolRegistry());
            assertEquals("应抛错", "未抛错");
        } catch (java.io.IOException expected) {
            assertTrue(expected.getMessage().contains("ghost"));
        }
    }
}
