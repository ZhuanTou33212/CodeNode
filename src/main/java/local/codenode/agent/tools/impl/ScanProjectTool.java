package local.codenode.agent.tools.impl;

import local.codenode.AutoLayout;
import local.codenode.ProjectGraphBuilder;
import local.codenode.ProjectScanner;
import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * scan_project：复用 ProjectScanner 全量扫描 + ProjectGraphBuilder 自动建图，返回统计。
 */
public final class ScanProjectTool {

    private ScanProjectTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "scan_project",
            "全量扫描项目根目录（源码+资产），构建项目分析节点图并返回统计（源文件/资产/组/文件/资源组/节点/边）。"
                + "applyToWorkbench=true 时会把符合项目结构的图（资产聚为资源组、源码按包归组）原生写入工作台。",
            Map.of("type", "object",
                "properties", Map.of(
                    "path", Map.of("type", "string", "description", "项目根目录，缺省用当前项目目录"),
                    "applyToWorkbench", Map.of("type", "boolean", "description", "是否把生成的节点图写入工作台，默认 false"))),
            ScanProjectTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        Path root;
        Object rawPath = arguments.get("path");
        if (rawPath != null && !String.valueOf(rawPath).isBlank()) {
            root = Path.of(String.valueOf(rawPath)).toAbsolutePath().normalize();
        } else {
            root = context.projectRoot();
        }
        if (!Files.isDirectory(root)) return AgentToolResult.error("目录不存在：" + root);
        try {
            ProjectScanner.ScanResult scan = ProjectScanner.scan(root);
            WorkflowModel model = new WorkflowModel();
            ProjectGraphBuilder.build(model, scan, root);
            AutoLayout.layout(model, null);
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("root", root.toString());
            data.put("sourceFiles", scan.sourceFiles().size());
            data.put("assetFiles", scan.assetFiles().size());
            data.put("nodes", model.nodes().size());
            data.put("edges", model.edges().size());
            data.put("groups", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP).count());
            data.put("files", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.FILE).count());
            data.put("assetBundles", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE).count());
            boolean applyToWorkbench = arguments.get("applyToWorkbench") instanceof Boolean b && b;
            if (applyToWorkbench && context.workbenchApplier() != null) {
                context.workbenchApplier().applyToWorkbench(model);
                context.audit("scan_project applyToWorkbench root=" + root);
                data.put("appliedToWorkbench", true);
            }
            return AgentToolResult.ok("扫描完成：源码=" + scan.sourceFiles().size()
                    + " 资产=" + scan.assetFiles().size()
                    + " 节点=" + model.nodes().size()
                    + " 边=" + model.edges().size()
                    + (applyToWorkbench ? "（已写入工作台）" : ""), data);
        } catch (Exception e) {
            return AgentToolResult.error("扫描失败：" + e.getMessage());
        }
    }
}
