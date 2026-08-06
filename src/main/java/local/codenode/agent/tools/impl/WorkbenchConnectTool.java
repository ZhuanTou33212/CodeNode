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
 * workbench_connect：节点连线操作。action=connect（sourceId→targetId，端口可缺省取第一个）或
 * disconnect（断开两节点之间连线，或仅断开某节点全部输入/输出）。
 */
public final class WorkbenchConnectTool {

    private WorkbenchConnectTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "workbench_connect",
            "节点连线。action=connect：sourceId(sourcePortId 可缺省) → targetId(targetPortId 可缺省)；"
                + "action=disconnect：断开 sourceId→targetId 之间连线；若只给 targetId 则断开其全部入边。",
            Map.of("type", "object",
                "properties", Map.of(
                    "action", Map.of("type", "string", "description", "connect 或 disconnect"),
                    "sourceId", Map.of("type", "string"),
                    "sourcePortId", Map.of("type", "string", "description", "缺省取第一个输出端口"),
                    "targetId", Map.of("type", "string"),
                    "targetPortId", Map.of("type", "string", "description", "缺省取第一个输入端口")),
                "required", List.of("action")),
            WorkbenchConnectTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase(Locale.ROOT);
        if (action.isEmpty()) return AgentToolResult.error("缺少 action");
        String sourceId = String.valueOf(arguments.getOrDefault("sourceId", "")).trim();
        String targetId = String.valueOf(arguments.getOrDefault("targetId", "")).trim();
        List<String> errors = new ArrayList<>();
        List<String> affected = new ArrayList<>();
        context.mutateWorkbench(model -> {
            switch (action) {
                case "connect" -> {
                    WorkflowModel.Node source = model.byId(sourceId);
                    WorkflowModel.Node target = model.byId(targetId);
                    if (source == null) { errors.add("源节点不存在: " + sourceId); break; }
                    if (target == null) { errors.add("目标节点不存在: " + targetId); break; }
                    WorkflowModel.Port sourcePort = sourceId.isBlank() ? null : portFor(model, source, String.valueOf(arguments.getOrDefault("sourcePortId", "")), true);
                    WorkflowModel.Port targetPort = targetId.isBlank() ? null : portFor(model, target, String.valueOf(arguments.getOrDefault("targetPortId", "")), false);
                    if (sourcePort == null) { errors.add("源节点没有可用输出端口: " + sourceId); break; }
                    if (targetPort == null) { errors.add("目标节点没有可用输入端口: " + targetId); break; }
                    WorkflowModel.ConnectionResult result = model.connectChecked(source, sourcePort, target, targetPort);
                    if (result.connected()) affected.add(sourceId + "→" + targetId);
                    else errors.add(result.reason());
                }
                case "disconnect" -> {
                    List<WorkflowModel.Edge> toRemove = new ArrayList<>();
                    for (WorkflowModel.Edge edge : model.edges()) {
                        boolean match;
                        if (!sourceId.isBlank() && !targetId.isBlank()) match = edge.source().equals(sourceId) && edge.target().equals(targetId);
                        else if (!targetId.isBlank()) match = edge.target().equals(targetId);
                        else match = edge.source().equals(sourceId);
                        if (match) toRemove.add(edge);
                    }
                    model.removeEdges(toRemove);
                    affected.add("断开 " + toRemove.size() + " 条连线");
                }
                default -> errors.add("未知 action: " + action);
            }
        });
        if (!errors.isEmpty()) return AgentToolResult.error(String.join("；", errors));
        return AgentToolResult.ok(String.join(", ", affected), Map.of("action", action));
    }

    private static WorkflowModel.Port portFor(WorkflowModel model, WorkflowModel.Node node, String portId, boolean output) {
        if (portId == null || portId.isBlank()) {
            return output ? (node.outputs.isEmpty() ? null : node.outputs.getFirst())
                          : (node.inputs.isEmpty() ? null : node.inputs.getFirst());
        }
        return output ? model.output(node, portId) : model.input(node, portId);
    }
}
