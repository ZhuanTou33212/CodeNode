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
 * get_workbench_model：遍历工作台 canvas 节点快照（直接访问字段），
 * 资源组节点附带 bundleData 与 groupInputNodeId。
 */
public final class GetWorkbenchModelTool {

    private GetWorkbenchModelTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "get_workbench_model",
            "获取当前工作台节点图快照：节点 id/name/nodeKind/x/y/端口；资源组附带 bundleData 与 groupInputNodeId。",
            Map.of("type", "object", "properties", Map.of()),
            GetWorkbenchModelTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        WorkflowModel model = context.model();
        if (model == null) return AgentToolResult.error("当前没有可用的工作台模型");
        List<Map<String, Object>> nodes = new ArrayList<>();
        for (WorkflowModel.Node node : model.nodes()) {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("id", node.id);
            value.put("name", node.name);
            value.put("nodeKind", node.nodeKind.name());
            value.put("category", node.category);
            value.put("x", node.x);
            value.put("y", node.y);
            value.put("relativePath", node.relativePath);
            if (node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
                value.put("bundleData", node.bundleData);
                value.put("groupInputNodeId", node.groupInputNodeId);
                value.put("memberCount", countMembers(node.bundleData));
            }
            value.put("inputs", node.inputs.stream().map(p -> p.name + ":" + p.dataType).toList());
            value.put("outputs", node.outputs.stream().map(p -> p.name + ":" + p.dataType).toList());
            nodes.add(value);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("nodeCount", model.nodes().size());
        data.put("edgeCount", model.edges().size());
        data.put("revision", model.revision());
        data.put("nodes", nodes);
        return AgentToolResult.ok("工作台共 " + model.nodes().size() + " 个节点、"
                + model.edges().size() + " 条连线", data);
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
