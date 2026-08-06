package local.codenode.agent.tools.impl;

import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * workbench_structure：节点结构操作。action=group(nodeIds[,name]) / ungroup(nodeId) /
 * expand_bundle(nodeId) / add_port(nodeId,direction) / remove_port(nodeId,direction,portId)。
 */
public final class WorkbenchStructureTool {

    private WorkbenchStructureTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "workbench_structure",
            "节点结构操作。action：group（把 nodeIds 打包为组节点，可给 name）；ungroup（解开组 nodeId）；"
                + "expand_bundle（把资源组 nodeId 展开为成员节点）；add_port / remove_port（增删输入输出端口，direction=input|output）。",
            Map.of("type", "object",
                "properties", Map.of(
                    "action", Map.of("type", "string", "description", "group/ungroup/expand_bundle/add_port/remove_port"),
                    "nodeId", Map.of("type", "string"),
                    "nodeIds", Map.of("type", "array", "items", Map.of("type", "string")),
                    "name", Map.of("type", "string", "description", "group 名称"),
                    "direction", Map.of("type", "string", "description", "input 或 output"),
                    "portId", Map.of("type", "string", "description", "remove_port 要删除的端口 id")),
                "required", List.of("action")),
            WorkbenchStructureTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase(Locale.ROOT);
        if (action.isEmpty()) return AgentToolResult.error("缺少 action");
        List<String> errors = new ArrayList<>();
        List<String> affected = new ArrayList<>();
        context.mutateWorkbench(model -> {
            switch (action) {
                case "group" -> group(model, arguments, errors, affected);
                case "ungroup" -> ungroup(model, arguments, errors, affected);
                case "expand_bundle" -> {
                    WorkflowModel.Node bundle = require(model, arguments, errors);
                    if (bundle == null) break;
                    if (bundle.nodeKind != WorkflowModel.NodeKind.ASSET_BUNDLE) { errors.add("不是资源组节点: " + bundle.id); break; }
                    List<WorkflowModel.Node> created = model.expandAssetBundle(bundle);
                    created.forEach(n -> affected.add(n.id));
                }
                case "add_port" -> {
                    WorkflowModel.Node node = require(model, arguments, errors);
                    if (node == null) break;
                    boolean output = "output".equals(String.valueOf(arguments.getOrDefault("direction", "output")));
                    WorkflowModel.Port port = model.addPort(node, output);
                    affected.add(node.id + ":" + port.id);
                }
                case "remove_port" -> {
                    WorkflowModel.Node node = require(model, arguments, errors);
                    if (node == null) break;
                    boolean output = "output".equals(String.valueOf(arguments.getOrDefault("direction", "input")));
                    String portId = String.valueOf(arguments.getOrDefault("portId", ""));
                    WorkflowModel.Port port = output ? model.output(node, portId) : model.input(node, portId);
                    if (port == null) { errors.add("端口不存在: " + portId); break; }
                    model.removePort(node, port, output);
                    affected.add(node.id + ":" + portId);
                }
                default -> errors.add("未知 action: " + action);
            }
        });
        if (!errors.isEmpty()) return AgentToolResult.error(String.join("；", errors));
        if (affected.isEmpty()) return AgentToolResult.ok("操作完成：" + action);
        return AgentToolResult.ok("已执行 " + action + "：" + String.join(", ", affected),
            Map.of("action", action, "nodeIds", affected));
    }

    private static void group(WorkflowModel model, Map<String, Object> arguments, List<String> errors, List<String> affected) {
        List<WorkflowModel.Node> selected = new ArrayList<>();
        Object rawList = arguments.get("nodeIds");
        if (rawList instanceof List<?> list) {
            for (Object item : list) {
                WorkflowModel.Node node = model.byId(String.valueOf(item));
                if (node != null) selected.add(node);
            }
        }
        if (selected.isEmpty()) { errors.add("group 需要 nodeIds"); return; }
        int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE;
        for (WorkflowModel.Node n : selected) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
        }
        String name = String.valueOf(arguments.getOrDefault("name", "节点组"));
        if ("null".equals(name)) name = "节点组";
        WorkflowModel.Node group = model.addGroupNode(minX - 20, minY - 40, name);
        for (WorkflowModel.Node n : selected) n.parentScopeId = group.id;
        WorkflowModel.Node gi = model.addGroupInputNode(group.x + 30, group.y + 60, "节点组输入");
        gi.parentScopeId = group.id;
        WorkflowModel.Node go = model.addNodeGroupOutput(group.x + 30, group.y + 120, "节点组输出");
        go.parentScopeId = group.id;
        affected.add(group.id);
    }

    private static void ungroup(WorkflowModel model, Map<String, Object> arguments, List<String> errors, List<String> affected) {
        WorkflowModel.Node group = require(model, arguments, errors);
        if (group == null) return;
        if (group.nodeKind != WorkflowModel.NodeKind.GROUP) { errors.add("不是组节点: " + group.id); return; }
        List<WorkflowModel.Node> toRemove = new ArrayList<>();
        for (WorkflowModel.Node child : model.nodes()) {
            if (!child.parentScopeId.equals(group.id)) continue;
            if (child.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT || child.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT) {
                toRemove.add(child);
            } else {
                child.parentScopeId = "";
            }
        }
        toRemove.forEach(model::removeNode);
        model.removeNode(group);
        affected.add(group.id);
    }

    private static WorkflowModel.Node require(WorkflowModel model, Map<String, Object> arguments, List<String> errors) {
        WorkflowModel.Node node = model.byId(String.valueOf(arguments.getOrDefault("nodeId", "")));
        if (node == null) errors.add("节点不存在: " + arguments.get("nodeId"));
        return node;
    }
}
