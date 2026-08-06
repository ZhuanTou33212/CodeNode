package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolSpec;
import local.codenode.config.AgentConfig;

/** 装配内嵌 Agent 的 17 个内置工具；可选按 {@link AgentConfig} 的工具设置过滤（tools.enabled / tools.disabled）。 */
public final class AgentToolkit {
    private AgentToolkit() {}

    /** 全量注册（无过滤）。 */
    public static AgentToolRegistry buildDefaultRegistry(AgentToolContext context) {
        return buildDefaultRegistry(context, null);
    }

    /** 按配置注册：config 非空时，tools.enabled / tools.disabled 决定哪些工具保留。 */
    public static AgentToolRegistry buildDefaultRegistry(AgentToolContext context, AgentConfig config) {
        AgentToolRegistry registry = new AgentToolRegistry();
        registerAll(registry);
        return filterByConfig(registry, config);
    }

    /** 注册后按配置移除被禁用的工具（保持注册顺序稳定）。 */
    public static AgentToolRegistry filterByConfig(AgentToolRegistry registry, AgentConfig config) {
        if (config == null) return registry;
        for (AgentToolSpec spec : registry.listTools()) {
            if (!config.isToolAllowed(spec.name())) {
                registry.unregister(spec.name());
            }
        }
        return registry;
    }

    private static void registerAll(AgentToolRegistry registry) {
        GetWorkbenchModelTool.register(registry);
        CreateNodesTool.register(registry);
        WorkbenchEditTool.register(registry);
        WorkbenchConnectTool.register(registry);
        WorkbenchStructureTool.register(registry);
        ScanProjectTool.register(registry);
        ReadFileTool.register(registry);
        WriteFileTool.register(registry);
        EditFileTool.register(registry);
        FindFilesTool.register(registry);
        SearchFilesTool.register(registry);
        ListDirectoryTool.register(registry);
        ExecuteShellTool.register(registry);
        CodeReviewTool.register(registry);
        AskUserTool.register(registry);
        FetchUrlTool.register(registry);
        SaveProjectTool.register(registry);
    }
}
