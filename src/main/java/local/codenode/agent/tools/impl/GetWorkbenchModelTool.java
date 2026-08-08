package local.codenode.agent.tools.impl;

import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * get_workbench_model：完整读取工作台画布——节点（id/name/nodeKind/分类/端口/相对路径/所属组/
 * 代码槽/资产信息）、连线（源→目标）、组关系与统计。让 Agent 能理解画布内全部信息。
 * view=full（默认）返回全部节点；view=groups 只返回组层级；view=targets 只返回带代码槽的可执行节点。
 */
public final class GetWorkbenchModelTool {

    private GetWorkbenchModelTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "get_workbench_model",
            "完整读取工作台画布：节点列表（id/name/nodeKind/category/x/y/relativePath/parentScopeId/"
                + "fileNodeId/端口/代码槽语言与行数；资源组附带 bundleData 与 memberCount）、"
                + "连线列表（source→target 端口）、节点统计与组数。view=full（默认）全部；"
                + "view=groups 只看组与成员；view=targets 只看带代码的可执行节点。"
                + "用于理解画布结构与连接关系，可据此定位节点 id 供其他工具使用。",
            Map.of("type", "object",
                "properties", Map.of(
                    "view", Map.of("type", "string", "description", "full/groups/targets，默认 full"))),
            GetWorkbenchModelTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        WorkflowModel model = context.model();
        if (model == null) return AgentToolResult.error("当前没有可用的工作台模型");
        String view = String.valueOf(arguments.getOrDefault("view", "full")).trim().toLowerCase();

        List<Map<String, Object>> nodes = new ArrayList<>();
        for (WorkflowModel.Node node : model.nodes()) {
            if ("groups".equals(view) && node.nodeKind != WorkflowModel.NodeKind.GROUP) continue;
            if ("targets".equals(view) && !hasCodeSlot(model, node)) continue;
            Map<String, Object> value = nodeValue(model, node);
            nodes.add(value);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("nodeCount", model.nodes().size());
        data.put("edgeCount", model.edges().size());
        data.put("revision", model.revision());
        data.put("groupCount", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP).count());
        data.put("view", view);
        data.put("nodes", nodes);
        if (!"groups".equals(view) && !"targets".equals(view)) {
            List<Map<String, Object>> edges = new ArrayList<>();
            for (WorkflowModel.Edge edge : model.edges()) {
                Map<String, Object> value = new LinkedHashMap<>();
                value.put("id", edge.id());
                value.put("source", edge.source());
                value.put("sourcePort", edge.sourcePort());
                value.put("target", edge.target());
                value.put("targetPort", edge.targetPort());
                edges.add(value);
            }
            data.put("edges", edges);
        }
        return AgentToolResult.ok("工作台共 " + model.nodes().size() + " 个节点、"
                + model.edges().size() + " 条连线（view=" + view + "）", data);
    }

    private static Map<String, Object> nodeValue(WorkflowModel model, WorkflowModel.Node node) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("id", node.id);
        value.put("name", node.name);
        value.put("nodeKind", node.nodeKind.name());
        value.put("category", node.category);
        value.put("classificationKey", node.classificationKey);
        value.put("x", node.x);
        value.put("y", node.y);
        value.put("relativePath", node.relativePath == null ? "" : node.relativePath);
        value.put("parentScopeId", node.parentScopeId == null ? "" : node.parentScopeId);
        value.put("fileNodeId", node.fileNodeId == null ? "" : node.fileNodeId);
        value.put("role", node.role == null ? "" : node.role);
        value.put("prompt", node.prompt == null ? "" : node.prompt);
        if (node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
            value.put("bundleData", node.bundleData == null ? "" : node.bundleData);
            value.put("groupInputNodeId", node.groupInputNodeId);
            value.put("memberCount", countMembers(node.bundleData));
        }
        if (node.nodeKind == WorkflowModel.NodeKind.ASSET) {
            value.put("assetType", node.assetType == null ? "" : node.assetType);
        }
        WorkflowModel.CodeSlot slot = codeSlotOf(model, node);
        if (slot != null) {
            Map<String, Object> code = new LinkedHashMap<>();
            code.put("slotId", slot.id);
            code.put("language", slot.language == null ? "" : slot.language);
            code.put("activeRevision", slot.activeRevision);
            code.put("lines", slot.activeCode == null ? 0 : slot.activeCode.lines().count());
            code.put("hasCode", slot.activeCode != null && !slot.activeCode.isBlank());
            value.put("codeSlot", code);
        }
        value.put("inputs", node.inputs.stream().map(p -> p.id + ":" + p.name + ":" + p.dataType).toList());
        value.put("outputs", node.outputs.stream().map(p -> p.id + ":" + p.name + ":" + p.dataType).toList());
        return value;
    }

    private static WorkflowModel.CodeSlot codeSlotOf(WorkflowModel model, WorkflowModel.Node node) {
        if (node.nodeKind == WorkflowModel.NodeKind.FILE) return model.codeSlot("file:" + node.id);
        if (node.codeBearing) return model.codeSlot("node:" + node.id);
        return null;
    }

    private static boolean hasCodeSlot(WorkflowModel model, WorkflowModel.Node node) {
        WorkflowModel.CodeSlot slot = codeSlotOf(model, node);
        return slot != null && slot.activeCode != null && !slot.activeCode.isBlank();
    }

    private static int countMembers(String bundleData) {
        if (bundleData == null || bundleData.isBlank()) return 0;
        try {
            Map<String, Object> root = local.codenode.Json.object(bundleData);
            Object members = root.get("members");
            if (members instanceof List<?> list) return list.size();
            Object files = root.get("files");
            if (files instanceof List<?> list) return list.size();
        } catch (RuntimeException ignored) {}
        return 0;
    }
}
