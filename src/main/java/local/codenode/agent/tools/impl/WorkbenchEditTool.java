package local.codenode.agent.tools.impl;

import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * workbench_edit：工作台节点编辑（泛化参数化，一个工具覆盖多数编辑操作）。
 * action 支持：rename / move / set_prompt / set_category / set_value_type / set_node_kind /
 * set_color / set_status / set_collapsed / set_muted / delete / duplicate / undo / redo。
 */
public final class WorkbenchEditTool {

    private WorkbenchEditTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "workbench_edit",
            "编辑工作台节点。action：rename(move(name)/x,y)、move(x,y)、set_prompt(value)、set_category(value)、"
                + "set_value_type(value)、set_node_kind(value: regular/calculation/condition/capture/file/asset)、"
                + "set_color(value)、set_status(value: idle/queued/processing/...)、set_collapsed(value true/false)、"
                + "set_muted(value)、delete(nodeId 或 nodeIds)、duplicate(nodeId[,offsetX,offsetY])、undo、redo。",
            Map.of("type", "object",
                "properties", Map.of(
                    "action", Map.of("type", "string", "description", "要执行的操作"),
                    "nodeId", Map.of("type", "string", "description", "目标节点 id"),
                    "nodeIds", Map.of("type", "array", "items", Map.of("type", "string"), "description", "批量目标节点 id"),
                    "name", Map.of("type", "string"),
                    "value", Map.of("type", "string", "description", "set_* 操作的新值"),
                    "x", Map.of("type", "integer"),
                    "y", Map.of("type", "integer"),
                    "offsetX", Map.of("type", "integer", "description", "duplicate 偏移，默认 40"),
                    "offsetY", Map.of("type", "integer", "description", "duplicate 偏移，默认 40")),
                "required", List.of("action")),
            WorkbenchEditTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase(Locale.ROOT);
        if (action.isEmpty()) return AgentToolResult.error("缺少 action");
        List<String> errors = new ArrayList<>();
        List<String> affected = new ArrayList<>();
        context.mutateWorkbench(model -> {
            switch (action) {
                case "undo" -> context.undo();
                case "redo" -> context.redo();
                case "rename" -> {
                    WorkflowModel.Node node = model.byId(String.valueOf(arguments.getOrDefault("nodeId", "")));
                    if (node == null) { errors.add("节点不存在: " + arguments.get("nodeId")); break; }
                    node.name = stringValue(arguments, "name", node.name);
                    affected.add(node.id);
                }
                case "move" -> {
                    WorkflowModel.Node node = model.byId(String.valueOf(arguments.getOrDefault("nodeId", "")));
                    if (node == null) { errors.add("节点不存在: " + arguments.get("nodeId")); break; }
                    node.x = intArg(arguments, "x", node.x);
                    node.y = intArg(arguments, "y", node.y);
                    affected.add(node.id);
                }
                case "set_prompt" -> setField(model, arguments, "prompt", errors, affected, value -> value);
                case "set_category" -> setField(model, arguments, "category", errors, affected, value -> value);
                case "set_value_type" -> setField(model, arguments, "valueType", errors, affected, value -> value);
                case "set_color" -> setField(model, arguments, "nodeColor", errors, affected, value -> value);
                case "set_node_kind" -> {
                    WorkflowModel.Node node = require(model, arguments, errors);
                    if (node == null) break;
                    String kind = stringValue(arguments, "value", "").toUpperCase(Locale.ROOT);
                    try {
                        node.nodeKind = WorkflowModel.NodeKind.valueOf(kind);
                        node.classificationKey = classificationFor(node.nodeKind);
                        affected.add(node.id);
                    } catch (IllegalArgumentException e) {
                        errors.add("未知节点类型: " + kind);
                    }
                }
                case "set_status" -> {
                    WorkflowModel.Node node = require(model, arguments, errors);
                    if (node == null) break;
                    String status = stringValue(arguments, "value", "").toUpperCase(Locale.ROOT);
                    try {
                        node.status = WorkflowModel.Status.valueOf(status);
                        affected.add(node.id);
                    } catch (IllegalArgumentException e) {
                        errors.add("未知状态: " + status);
                    }
                }
                case "set_collapsed" -> {
                    WorkflowModel.Node node = require(model, arguments, errors);
                    if (node == null) break;
                    node.collapsed = Boolean.parseBoolean(stringValue(arguments, "value", "false"));
                    affected.add(node.id);
                }
                case "set_muted" -> {
                    WorkflowModel.Node node = require(model, arguments, errors);
                    if (node == null) break;
                    node.muted = Boolean.parseBoolean(stringValue(arguments, "value", "false"));
                    affected.add(node.id);
                }
                case "delete" -> {
                    List<String> ids = nodeIds(arguments);
                    if (ids.isEmpty()) { errors.add("缺少要删除的 nodeId"); break; }
                    for (String id : ids) {
                        WorkflowModel.Node node = model.byId(id);
                        if (node == null) { errors.add("节点不存在: " + id); continue; }
                        model.removeNode(node);
                        affected.add(id);
                    }
                }
                case "duplicate" -> {
                    WorkflowModel.Node node = require(model, arguments, errors);
                    if (node == null) break;
                    int ox = intArg(arguments, "offsetX", 40);
                    int oy = intArg(arguments, "offsetY", 40);
                    WorkflowModel.Node copy = model.duplicate(node, node.x + ox, node.y + oy);
                    affected.add(copy.id);
                }
                default -> errors.add("未知 action: " + action);
            }
        });
        if (!errors.isEmpty()) return AgentToolResult.error(String.join("；", errors));
        if (affected.isEmpty()) return AgentToolResult.ok("操作完成：" + action);
        return AgentToolResult.ok("已执行 " + action + "，节点: " + String.join(", ", affected),
            Map.of("action", action, "nodeIds", affected));
    }

    private static WorkflowModel.Node require(WorkflowModel model, Map<String, Object> arguments, List<String> errors) {
        WorkflowModel.Node node = model.byId(String.valueOf(arguments.getOrDefault("nodeId", "")));
        if (node == null) errors.add("节点不存在: " + arguments.get("nodeId"));
        return node;
    }

    private static void setField(WorkflowModel model, Map<String, Object> arguments, String field,
                                 List<String> errors, List<String> affected,
                                 java.util.function.Function<String, String> convert) {
        WorkflowModel.Node node = require(model, arguments, errors);
        if (node == null) return;
        String value = convert.apply(stringValue(arguments, "value", ""));
        switch (field) {
            case "prompt" -> node.prompt = value;
            case "category" -> node.category = value;
            case "valueType" -> node.valueType = value;
            case "nodeColor" -> node.nodeColor = value;
            default -> { errors.add("未知字段: " + field); return; }
        }
        affected.add(node.id);
    }

    private static String classificationFor(WorkflowModel.NodeKind kind) {
        return switch (kind) {
            case CALCULATION -> "calculation.scalar";
            case CONDITION -> "calculation.boolean";
            case FILE -> "file.source";
            case ASSET -> "asset.other";
            case ASSET_BUNDLE -> "asset.other";
            case GROUP -> "scope.group";
            case GROUP_INPUT, GROUP_OUTPUT, CAPTURE -> "io.group-input";
            case SCOPE -> "scope.flow";
            default -> "foundation.object";
        };
    }

    private static List<String> nodeIds(Map<String, Object> arguments) {
        List<String> ids = new ArrayList<>();
        Object single = arguments.get("nodeId");
        if (single != null && !String.valueOf(single).isBlank()) ids.add(String.valueOf(single));
        Object rawList = arguments.get("nodeIds");
        if (rawList instanceof List<?> list) {
            for (Object item : list) if (item != null && !String.valueOf(item).isBlank()) ids.add(String.valueOf(item));
        }
        return ids;
    }

    private static String stringValue(Map<String, Object> arguments, String key, String fallback) {
        Object value = arguments.get(key);
        if (value == null || "null".equals(String.valueOf(value))) return fallback;
        return String.valueOf(value);
    }

    private static int intArg(Map<String, Object> arguments, String key, int fallback) {
        return arguments.get(key) instanceof Number number ? number.intValue() : fallback;
    }
}
