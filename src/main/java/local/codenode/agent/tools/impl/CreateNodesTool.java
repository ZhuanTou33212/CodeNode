/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import local.codenode.Json;
import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

public final class CreateNodesTool {
    private static final int MAX_COUNT = 50;

    private CreateNodesTool() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("create_nodes", "在工作台创建节点。count 指定数量（默认1，最多50）；name 为名称（数量>1 时自动编号如 名1/名2）；category/prompt/valueType 可选；nodeKind 支持 regular/calculation/condition/capture，也可用预设类型：file（文件节点，relativePath 必填）/asset（资产节点，assetType+relativePath）/bundle（资源组，assetType 为资产类型）/group（空节点组）；relativePath 为文件/资产相对路径；connect=true 时按创建顺序串联成链。创建后返回节点 id 列表。", Map.of("type", "object", "properties", Map.of("count", Map.of("type", "integer", "description", "节点数量，默认 1，最多 50"), "name", Map.of("type", "string", "description", "节点名称或前缀"), "category", Map.of("type", "string", "description", "节点分类，如 基础/数值/文本"), "prompt", Map.of("type", "string", "description", "节点职责说明"), "valueType", Map.of("type", "string", "description", "值类型，默认 any"), "nodeKind", Map.of("type", "string", "description", "regular/calculation/condition/capture 或预设 file/asset/bundle/group"), "assetType", Map.of("type", "string", "description", "资产类型：image/model/texture/animation/particle/language/audio/video/other"), "relativePath", Map.of("type", "string", "description", "file/asset 节点的相对路径"), "connect", Map.of("type", "boolean", "description", "是否按顺序串联，默认 false")), "required", List.of()), CreateNodesTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        Boolean value;
        int n;
        Object object = arguments.get("count");
        if (object instanceof Number) {
            Number number = (Number)object;
            n = Math.max(1, Math.min(50, number.intValue()));
        } else {
            n = 1;
        }
        int count = n;
        String baseName = CreateNodesTool.stringArg(arguments, "name", "节点");
        String category = CreateNodesTool.stringArg(arguments, "category", "基础");
        String prompt = CreateNodesTool.stringArg(arguments, "prompt", "说明这个节点应完成的工作");
        String valueType = CreateNodesTool.stringArg(arguments, "valueType", "any");
        String nodeKind = CreateNodesTool.stringArg(arguments, "nodeKind", "regular").toLowerCase(Locale.ROOT);
        Object object2 = arguments.get("connect");
        boolean connect = object2 instanceof Boolean && (value = (Boolean)object2) != false;
        ArrayList ids = new ArrayList();
        context.mutateWorkbench(model -> {
            int i;
            ArrayList<WorkflowModel.Node> created = new ArrayList<WorkflowModel.Node>();
            int baseX = 120;
            int baseY = 120;
            for (i = 0; i < count; ++i) {
                String nodeName = count == 1 ? baseName : baseName + (i + 1);
                WorkflowModel.Node node = CreateNodesTool.createPresetNode(model, nodeKind, nodeName, arguments, baseX, baseY + i * 110);
                created.add(node);
                ids.add(node.id);
            }
            if (connect && created.size() >= 2) {
                i = 0;
                while (i + 1 < created.size()) {
                    model.connect((WorkflowModel.Node)created.get(i), (WorkflowModel.Node)created.get(i + 1));
                    ++i;
                }
            }
        });
        if (ids.isEmpty()) {
            return AgentToolResult.error("没有创建任何节点（工作台不可用）");
        }
        context.audit("create_nodes count=" + count + " name=" + baseName + " kind=" + nodeKind + " connect=" + connect);
        return AgentToolResult.ok("已创建 " + ids.size() + " 个节点：" + String.join((CharSequence)", ", ids), Map.of("nodeIds", ids, "count", ids.size()));
    }

    private static WorkflowModel.Node createPresetNode(WorkflowModel model, String nodeKind, String name, Map<String, Object> arguments, int x, int y) {
        String category = CreateNodesTool.stringArg(arguments, "category", "基础");
        String prompt = CreateNodesTool.stringArg(arguments, "prompt", "说明这个节点应完成的工作");
        String valueType = CreateNodesTool.stringArg(arguments, "valueType", "any");
        String relativePath = CreateNodesTool.stringArg(arguments, "relativePath", "");
        String assetType = CreateNodesTool.stringArg(arguments, "assetType", "image");
        return switch (nodeKind) {
            case "file" -> {
                WorkflowModel.Node node = model.addFileNode(x, y, name, relativePath);
                node.prompt = prompt.isBlank() ? "文件: " + (relativePath.isBlank() ? name : relativePath) : prompt;
                node.parentScopeId = "";
                yield node;
            }
            case "asset" -> {
                WorkflowModel.Node node = model.addAssetNode(x, y, name, relativePath, assetType);
                node.prompt = prompt.isBlank() ? "资产: " + (relativePath.isBlank() ? name : relativePath) : prompt;
                node.parentScopeId = "";
                yield node;
            }
            case "bundle" -> {
                String bundleData = "";
                if (!relativePath.isBlank()) {
                    bundleData = CreateNodesTool.buildSingleBundleData(relativePath, assetType);
                }
                WorkflowModel.Node node = model.addAssetBundleNode(x, y, name, bundleData, assetType);
                node.prompt = prompt.isBlank() ? "资源组: " + name : prompt;
                node.parentScopeId = "";
                yield node;
            }
            case "group" -> {
                WorkflowModel.Node node = model.addGroupNode(x, y, name);
                node.parentScopeId = "";
                yield node;
            }
            default -> {
                WorkflowModel.Node node = model.addNode(x, y);
                node.name = name;
                node.category = category;
                node.prompt = prompt;
                node.valueType = valueType;
                CreateNodesTool.applyKind(node, nodeKind);
                yield node;
            }
        };
    }

    private static String buildSingleBundleData(String relativePath, String assetType) {
        LinkedHashMap<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("schemaVersion", 2);
        data.put("memberCount", 1);
        data.put("categoryStats", Map.of(assetType, 1));
        data.put("members", List.of(Map.of("id", "b-" + Integer.toHexString(relativePath.hashCode()), "relativePath", relativePath, "name", relativePath.contains("/") ? relativePath.substring(relativePath.lastIndexOf(47) + 1) : relativePath, "category", assetType)));
        return Json.stringify(data);
    }

    private static void applyKind(WorkflowModel.Node node, String nodeKind) {
        switch (nodeKind) {
            case "calculation": {
                node.nodeKind = WorkflowModel.NodeKind.CALCULATION;
                node.classificationKey = "calculation.scalar";
                break;
            }
            case "condition": {
                node.nodeKind = WorkflowModel.NodeKind.CONDITION;
                node.classificationKey = "calculation.boolean";
                node.valueType = "boolean";
                break;
            }
            case "capture": {
                node.nodeKind = WorkflowModel.NodeKind.CAPTURE;
                node.classificationKey = "io.capture";
                node.codeBearing = false;
                break;
            }
            default: {
                node.nodeKind = WorkflowModel.NodeKind.REGULAR;
                node.classificationKey = "foundation.object";
            }
        }
    }

    private static String stringArg(Map<String, Object> arguments, String key, String fallback) {
        Object value = arguments.get(key);
        if (value == null || "null".equals(String.valueOf(value))) {
            return fallback;
        }
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? fallback : text;
    }
}
