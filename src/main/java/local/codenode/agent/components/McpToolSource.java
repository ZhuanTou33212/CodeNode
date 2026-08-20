package local.codenode.agent.components;

import local.codenode.agent.mcp.McpStdioClient;
import local.codenode.agent.mcp.McpToolkit;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.config.AgentConfig;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 外部 MCP server 工具源：按 {@code mcp.servers} / {@code mcp.server.<name>}
 * 配置连接并注册远端工具（原 {@code McpToolkit.connectConfigured} 的组件化封装）。
 *
 * <p>连接失败不中断装配：失败信息记入 {@link #warning()}，由装配器汇总给 UI
 * 提示；已连上的 server 照常注册。退出时 {@link #close()} 逐个关闭 client。</p>
 */
public final class McpToolSource implements ToolSource {

    private final AgentConfig config;
    private final List<McpStdioClient> clients = new ArrayList<>();
    private String warning = "";

    public McpToolSource(AgentConfig config) {
        this.config = config;
    }

    @Override
    public String name() {
        return "mcp";
    }

    @Override
    public void registerInto(AgentToolRegistry registry) {
        try {
            clients.addAll(McpToolkit.connectConfigured(config, registry));
        } catch (IOException e) {
            warning = "MCP server 连接失败（可在 agent.properties 调整 mcp.servers）：" + e.getMessage();
        }
    }

    @Override
    public void close() {
        for (McpStdioClient client : clients) {
            try {
                client.close();
            } catch (RuntimeException ignored) {
            }
        }
        clients.clear();
    }

    @Override
    public String warning() {
        return warning;
    }
}
