/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import local.codenode.AutoLayout;
import local.codenode.DirectoryGraphBuilder;
import local.codenode.HierarchyLayout;
import local.codenode.ProjectGraphBuilder;
import local.codenode.ProjectScanner;
import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

public final class ScanProjectTool {
    private ScanProjectTool() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("scan_project", "全量扫描项目根目录（源码+资产，忽略缓存/构建目录）并构建项目分析节点图，返回统计。mode=hierarchy（默认）：按目录递归成组模拟文件管理器——资产叶子目录生成资源组（输出端口含每个资产名），其余目录成普通组（组内文件全部连到组输出，子组输出向上汇聚）；程序/配置文件用文件节点并引用相对路径。mode=package：按 package 归组、资产按父目录聚为资源组。applyToWorkbench=true 时把生成图原生写入工作台。", Map.of("type", "object", "properties", Map.of("path", Map.of("type", "string", "description", "项目根目录，缺省用当前项目目录"), "mode", Map.of("type", "string", "description", "hierarchy（默认，文件管理器层级）/ package（按包归组）"), "applyToWorkbench", Map.of("type", "boolean", "description", "是否把生成的节点图写入工作台，默认 false"))), ScanProjectTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        Object rawPath = arguments.get("path");
        Path root = rawPath != null && !String.valueOf(rawPath).isBlank() ? Path.of(String.valueOf(rawPath), new String[0]).toAbsolutePath().normalize() : context.projectRoot();
        if (!Files.isDirectory(root, new LinkOption[0])) {
            return AgentToolResult.error("目录不存在：" + String.valueOf(root));
        }
        String mode = String.valueOf(arguments.getOrDefault("mode", "hierarchy")).trim().toLowerCase();
        try {
            Boolean b;
            boolean applyToWorkbench;
            ProjectScanner.ScanResult scan = ProjectScanner.scan(root);
            WorkflowModel model = new WorkflowModel();
            boolean hierarchy = mode.equals("hierarchy");
            if (hierarchy) {
                DirectoryGraphBuilder.build(model, root);
            } else {
                ProjectGraphBuilder.build(model, scan, root);
            }
            if (hierarchy) {
                HierarchyLayout.layout(model);
            } else {
                AutoLayout.layout(model, null);
            }
            LinkedHashMap<String, Object> data = new LinkedHashMap<String, Object>();
            data.put("root", root.toString());
            data.put("mode", hierarchy ? "hierarchy" : "package");
            data.put("sourceFiles", scan.sourceFiles().size());
            data.put("assetFiles", scan.assetFiles().size());
            data.put("nodes", model.nodes().size());
            data.put("edges", model.edges().size());
            data.put("groups", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP).count());
            data.put("files", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.FILE).count());
            data.put("assets", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET).count());
            data.put("assetBundles", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE).count());
            data.put("folders", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP && "folder".equals(n.role)).count());
            Object object = arguments.get("applyToWorkbench");
            boolean bl = applyToWorkbench = object instanceof Boolean && (b = (Boolean)object) != false;
            if (applyToWorkbench && context.workbenchApplier() != null) {
                context.workbenchApplier().applyToWorkbench(model);
                context.audit("scan_project mode=" + mode + " applyToWorkbench root=" + String.valueOf(root));
                data.put("appliedToWorkbench", true);
            }
            return AgentToolResult.ok("扫描完成（" + (hierarchy ? "文件管理器层级" : "按包归组") + "）：源码=" + scan.sourceFiles().size() + " 资产=" + scan.assetFiles().size() + " 节点=" + model.nodes().size() + " 边=" + model.edges().size() + (applyToWorkbench ? "（已写入工作台）" : ""), data);
        }
        catch (Exception e) {
            return AgentToolResult.error("扫描失败：" + e.getMessage());
        }
    }
}
