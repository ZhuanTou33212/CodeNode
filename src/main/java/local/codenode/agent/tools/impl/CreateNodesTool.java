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
 * create_nodes：在工作台创建节点（原生 Agent 调度的核心落地工具）。
 * count 指定数量（默认 1，最多 50）；名称前缀自动编号；connect=true 时按顺序串联成链。
 */
public final class CreateNodesTool {

    private static final int MAX_COUNT = 50;

    private CreateNodesTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "create_nodes",
            "在工作台创建节点。count 指定数量（默认1，最多50）；name 为名称（数量>1 时自动编号如 名1/名2）；"
                + "category/prompt/valueType 可选；connect=true 时按创建顺序串联成链。创建后返回节点 id 列表。",
            Map.of("type", "object",
                "properties", Map.of(
                    "count", Map.of("type", "integer", "description", "节点数量，默认 1，最多 50"),
                    "name", Map.of("type", "string", "description", "节点名称或前缀"),
                    "category", Map.of("type", "string", "description", "节点分类，如 基础/数值/文本"),
                    "prompt", Map.of("type", "string", "description", "节点职责说明"),
                    "valueType", Map.of("type", "string", "description", "值类型，默认 any"),
                    "nodeKind", Map.of("type", "string", "description", "节点类型：regular(默认)/calculation/condition/capture"),
                    "connect", Map.of("type", "boolean", "description", "是否按顺序串联，默认 false")),
                "required", List.of()),
            CreateNodesTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        int count = arguments.get("count") instanceof Number number ? Math.max(1, Math.min(MAX_COUNT, number.intValue())) : 1;
        String baseName = stringArg(arguments, "name", "节点");
        String category = stringArg(arguments, "category", "基础");
        String prompt = stringArg(arguments, "prompt", "说明这个节点应完成的工作");
        String valueType = stringArg(arguments, "valueType", "any");
        String nodeKind = stringArg(arguments, "nodeKind", "regular").toLowerCase(Locale.ROOT);
        boolean connect = arguments.get("connect") instanceof Boolean value && value;

        List<String> ids = new ArrayList<>();
        context.mutateWorkbench(model -> {
            List<WorkflowModel.Node> created = new ArrayList<>();
            int baseX = 120;
            int baseY = 120;
            for (int i = 0; i < count; i++) {
                WorkflowModel.Node node = model.addNode(baseX, baseY + i * 110);
                node.name = count == 1 ? baseName : baseName + (i + 1);
                node.category = category;
                node.prompt = prompt;
                node.valueType = valueType;
                applyKind(node, nodeKind);
                created.add(node);
                ids.add(node.id);
            }
            if (connect && created.size() >= 2) {
                for (int i = 0; i + 1 < created.size(); i++) {
                    model.connect(created.get(i), created.get(i + 1));
                }
            }
        });
        if (ids.isEmpty()) return AgentToolResult.error("没有创建任何节点（工作台不可用）");
        context.audit("create_nodes count=" + count + " name=" + baseName + " kind=" + nodeKind + " connect=" + connect);
        return AgentToolResult.ok("已创建 " + ids.size() + " 个节点：" + String.join(", ", ids),
            Map.of("nodeIds", ids, "count", ids.size()));
    }

    private static void applyKind(WorkflowModel.Node node, String nodeKind) {
        switch (nodeKind) {
            case "calculation" -> {
                node.nodeKind = WorkflowModel.NodeKind.CALCULATION;
                node.classificationKey = "calculation.scalar";
            }
            case "condition" -> {
                node.nodeKind = WorkflowModel.NodeKind.CONDITION;
                node.classificationKey = "calculation.boolean";
                node.valueType = "boolean";
            }
            case "capture" -> {
                node.nodeKind = WorkflowModel.NodeKind.CAPTURE;
                node.classificationKey = "io.capture";
                node.codeBearing = false;
            }
            default -> {
                node.nodeKind = WorkflowModel.NodeKind.REGULAR;
                node.classificationKey = "foundation.object";
            }
        }
    }

    private static String stringArg(Map<String, Object> arguments, String key, String fallback) {
        Object value = arguments.get(key);
        if (value == null || "null".equals(String.valueOf(value))) return fallback;
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? fallback : text;
    }
}
