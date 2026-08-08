/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

public final class WorkbenchStructureTool {
    private WorkbenchStructureTool() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("workbench_structure", "节点结构操作。action：group（把 nodeIds 打包为组节点，可给 name）；ungroup（解开组 nodeId）；ungroup_bundle（把资源组 nodeId 解组为普通组并进入组视图展示全部资产）；expand_bundle（把资源组 nodeId 展开为成员节点）；add_port / remove_port（增删输入输出端口，direction=input|output）。", Map.of("type", "object", "properties", Map.of("action", Map.of("type", "string", "description", "group/ungroup/ungroup_bundle/expand_bundle/add_port/remove_port"), "nodeId", Map.of("type", "string"), "nodeIds", Map.of("type", "array", "items", Map.of("type", "string")), "name", Map.of("type", "string", "description", "group 名称"), "direction", Map.of("type", "string", "description", "input 或 output"), "portId", Map.of("type", "string", "description", "remove_port 要删除的端口 id")), "required", List.of("action")), WorkbenchStructureTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase(Locale.ROOT);
        if (action.isEmpty()) {
            return AgentToolResult.error("缺少 action");
        }
        ArrayList errors = new ArrayList();
        ArrayList affected = new ArrayList();
        context.mutateWorkbench(model -> {
            switch (action) {
                case "group": {
                    WorkbenchStructureTool.group(model, arguments, errors, affected);
                    break;
                }
                case "ungroup": {
                    WorkbenchStructureTool.ungroup(model, arguments, errors, affected);
                    break;
                }
                case "ungroup_bundle": {
                    WorkflowModel.Node bundle = WorkbenchStructureTool.require(model, arguments, errors);
                    if (bundle == null) break;
                    WorkflowModel.Node group = model.ungroupAssetBundleToGroup(bundle);
                    if (group == null) {
                        errors.add("不是资源组节点: " + bundle.id);
                        break;
                    }
                    affected.add(group.id);
                    break;
                }
                case "expand_bundle": {
                    WorkflowModel.Node bundle = WorkbenchStructureTool.require(model, arguments, errors);
                    if (bundle == null) break;
                    if (bundle.nodeKind != WorkflowModel.NodeKind.ASSET_BUNDLE) {
                        errors.add("不是资源组节点: " + bundle.id);
                        break;
                    }
                    List<WorkflowModel.Node> created = model.expandAssetBundle(bundle);
                    created.forEach(n -> affected.add(n.id));
                    break;
                }
                case "add_port": {
                    WorkflowModel.Node node = WorkbenchStructureTool.require(model, arguments, errors);
                    if (node == null) break;
                    boolean output = "output".equals(String.valueOf(arguments.getOrDefault("direction", "output")));
                    WorkflowModel.Port port = model.addPort(node, output);
                    affected.add(node.id + ":" + port.id);
                    break;
                }
                case "remove_port": {
                    WorkflowModel.Port port;
                    WorkflowModel.Node node = WorkbenchStructureTool.require(model, arguments, errors);
                    if (node == null) break;
                    boolean output = "output".equals(String.valueOf(arguments.getOrDefault("direction", "input")));
                    String portId = String.valueOf(arguments.getOrDefault("portId", ""));
                    WorkflowModel.Port port2 = port = output ? model.output(node, portId) : model.input(node, portId);
                    if (port == null) {
                        errors.add("端口不存在: " + portId);
                        break;
                    }
                    model.removePort(node, port, output);
                    affected.add(node.id + ":" + portId);
                    break;
                }
                default: {
                    errors.add("未知 action: " + action);
                }
            }
        });
        if (!errors.isEmpty()) {
            return AgentToolResult.error(String.join((CharSequence)"；", errors));
        }
        if (affected.isEmpty()) {
            return AgentToolResult.ok("操作完成：" + action);
        }
        return AgentToolResult.ok("已执行 " + action + "：" + String.join((CharSequence)", ", affected), Map.of("action", action, "nodeIds", affected));
    }

    private static void group(WorkflowModel model, Map<String, Object> arguments, List<String> errors, List<String> affected) {
        ArrayList<WorkflowModel.Node> selected = new ArrayList<WorkflowModel.Node>();
        Object rawList = arguments.get("nodeIds");
        if (rawList instanceof List) {
            List<?> list = (List<?>)rawList;
            for (Object item : list) {
                WorkflowModel.Node node = model.byId(String.valueOf(item));
                if (node == null) continue;
                selected.add(node);
            }
        }
        if (selected.isEmpty()) {
            errors.add("group 需要 nodeIds");
            return;
        }
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        for (WorkflowModel.Node n : selected) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
        }
        String name = String.valueOf(arguments.getOrDefault("name", "节点组"));
        if ("null".equals(name)) {
            name = "节点组";
        }
        WorkflowModel.Node group = model.addGroupNode(minX - 20, minY - 40, name);
        for (WorkflowModel.Node n : selected) {
            n.parentScopeId = group.id;
        }
        WorkflowModel.Node gi = model.addGroupInputNode(group.x + 30, group.y + 60, "节点组输入");
        gi.parentScopeId = group.id;
        WorkflowModel.Node go = model.addNodeGroupOutput(group.x + 30, group.y + 120, "节点组输出");
        go.parentScopeId = group.id;
        affected.add(group.id);
    }

    private static void ungroup(WorkflowModel model, Map<String, Object> arguments, List<String> errors, List<String> affected) {
        WorkflowModel.Node group = WorkbenchStructureTool.require(model, arguments, errors);
        if (group == null) {
            return;
        }
        if (group.nodeKind != WorkflowModel.NodeKind.GROUP) {
            errors.add("不是组节点: " + group.id);
            return;
        }
        ArrayList<WorkflowModel.Node> toRemove = new ArrayList<WorkflowModel.Node>();
        for (WorkflowModel.Node child : model.nodes()) {
            if (!child.parentScopeId.equals(group.id)) continue;
            if (child.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT || child.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT) {
                toRemove.add(child);
                continue;
            }
            child.parentScopeId = "";
        }
        toRemove.forEach(model::removeNode);
        model.removeNode(group);
        affected.add(group.id);
    }

    private static WorkflowModel.Node require(WorkflowModel model, Map<String, Object> arguments, List<String> errors) {
        WorkflowModel.Node node = model.byId(String.valueOf(arguments.getOrDefault("nodeId", "")));
        if (node == null) {
            errors.add("节点不存在: " + String.valueOf(arguments.get("nodeId")));
        }
        return node;
    }
}
