package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;

/** 装配 Stage4.5 的 6 个内置工具。 */
public final class AgentToolkit {
    private AgentToolkit() {}

    public static AgentToolRegistry buildDefaultRegistry(AgentToolContext context) {
        AgentToolRegistry registry = new AgentToolRegistry();
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
        return registry;
    }
}
