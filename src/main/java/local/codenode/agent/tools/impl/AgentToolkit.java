/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolSpec;
import local.codenode.agent.tools.impl.AskUserTool;
import local.codenode.agent.tools.impl.CodeReviewTool;
import local.codenode.agent.tools.impl.CompileRunTool;
import local.codenode.agent.tools.impl.CreateNodesTool;
import local.codenode.agent.tools.impl.EditFileTool;
import local.codenode.agent.tools.impl.ExecuteShellTool;
import local.codenode.agent.tools.impl.FetchUrlTool;
import local.codenode.agent.tools.impl.FindFilesTool;
import local.codenode.agent.tools.impl.GetWorkbenchModelTool;
import local.codenode.agent.tools.impl.ListDirectoryTool;
import local.codenode.agent.tools.impl.ReadFileTool;
import local.codenode.agent.tools.impl.ReadToolResultTool;
import local.codenode.agent.tools.impl.RuntimeTraceTool;
import local.codenode.agent.tools.impl.SaveProjectTool;
import local.codenode.agent.tools.impl.ScanProjectTool;
import local.codenode.agent.tools.impl.SearchFilesTool;
import local.codenode.agent.tools.impl.UiControlTool;
import local.codenode.agent.tools.impl.WorkbenchConnectTool;
import local.codenode.agent.tools.impl.WorkbenchEditTool;
import local.codenode.agent.tools.impl.WorkbenchStructureTool;
import local.codenode.agent.tools.impl.WriteAnalysisMdTool;
import local.codenode.agent.tools.impl.WriteFileTool;
import local.codenode.config.AgentConfig;

public final class AgentToolkit {
    private AgentToolkit() {
    }

    public static AgentToolRegistry buildDefaultRegistry(AgentToolContext context) {
        return AgentToolkit.buildDefaultRegistry(context, null);
    }

    public static AgentToolRegistry buildDefaultRegistry(AgentToolContext context, AgentConfig config) {
        AgentToolRegistry registry = new AgentToolRegistry();
        AgentToolkit.registerAll(registry);
        return AgentToolkit.filterByConfig(registry, config);
    }

    public static AgentToolRegistry filterByConfig(AgentToolRegistry registry, AgentConfig config) {
        if (config == null) {
            return registry;
        }
        for (AgentToolSpec spec : registry.listTools()) {
            if (config.isToolAllowed(spec.name())) continue;
            registry.unregister(spec.name());
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
        ReadToolResultTool.register(registry);
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
        CompileRunTool.register(registry);
        RuntimeTraceTool.register(registry);
        WriteAnalysisMdTool.register(registry);
        UiControlTool.register(registry);
        ProjectInfoTool.register(registry);
        BuildProjectTool.register(registry);
        RunProjectTool.register(registry);
        ListTasksTool.register(registry);
        BulkEditTool.register(registry);
        AnalyzeProjectTool.register(registry);
        GraphTools.register(registry);
    }
}
