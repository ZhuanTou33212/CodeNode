package local.codenode.agent.tools.impl;

import local.codenode.Json;
import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * bulk_edit：允许 Agent 进行大批量数据修改——批量创建节点/文件节点/资产节点、批量删除节点、
 * 批量写入文件（创建/覆盖）。所有批量修改都是高危操作，执行前必须经用户确认，
 * 并以自然语言解释将要做什么（创建 N 个、删除 N 个、写入哪些文件）。
 */
public final class BulkEditTool {
    private static final int MAX_BATCH = 200;

    private BulkEditTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "bulk_edit",
            "大批量数据修改（高危，需用户确认）。action："
                + "create_nodes(count,name,category,prompt,connect) 批量创建普通节点；"
                + "create_files(list[{path,content}]) 批量创建/写入文件（越界拒绝）；"
                + "create_assets(list[{path,assetType}]) 批量创建资产节点；"
                + "delete_nodes(nodeIds) 批量删除工作台节点。"
                + "执行前会请求用户确认并解释将做什么；创建/删除完成后返回影响数量。",
            Map.of("type", "object",
                "properties", Map.of(
                    "action", Map.of("type", "string", "description", "create_nodes/create_files/create_assets/delete_nodes"),
                    "count", Map.of("type", "integer", "description", "create_nodes 数量（最多 " + MAX_BATCH + "）"),
                    "name", Map.of("type", "string", "description", "create_nodes 名称前缀"),
                    "category", Map.of("type", "string", "description", "create_nodes 分类"),
                    "prompt", Map.of("type", "string", "description", "create_nodes 职责说明"),
                    "connect", Map.of("type", "boolean", "description", "create_nodes 是否串联"),
                    "list", Map.of("type", "array", "items", Map.of("type", "object"), "description", "create_files/create_assets 的条目列表"),
                    "nodeIds", Map.of("type", "array", "items", Map.of("type", "string"), "description", "delete_nodes 目标节点 id")),
                "required", List.of("action")),
            BulkEditTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase(Locale.ROOT);
        if (action.isBlank()) return AgentToolResult.error("缺少 action");
        // 描述本次批量操作，供用户确认（自然语言）
        String what = describe(action, arguments);
        String detail = detailFor(action, arguments, context);
        if (!context.confirm(local.codenode.agent.tools.AgentToolContext.ConfirmationLevel.HIGH, what, detail)) {
            return AgentToolResult.error("已取消批量操作");
        }
        try {
            switch (action) {
                case "create_nodes": return createNodes(context, arguments);
                case "create_files": return createFiles(context, arguments);
                case "create_assets": return createAssets(context, arguments);
                case "delete_nodes": return deleteNodes(context, arguments);
                default: return AgentToolResult.error("未知 action: " + action);
            }
        } catch (Exception e) {
            return AgentToolResult.error("批量操作失败：" + e.getMessage());
        }
    }

    private static String describe(String action, Map<String, Object> arguments) {
        return switch (action) {
            case "create_nodes" -> "批量创建 " + intArg(arguments, "count", 1) + " 个工作台节点";
            case "create_files" -> "批量写入 " + listSize(arguments) + " 个文件";
            case "create_assets" -> "批量创建 " + listSize(arguments) + " 个资产节点";
            case "delete_nodes" -> "批量删除 " + nodeIds(arguments).size() + " 个工作台节点";
            default -> "执行批量操作 " + action;
        };
    }

    private static String detailFor(String action, Map<String, Object> arguments, AgentToolContext context) {
        StringBuilder sb = new StringBuilder();
        sb.append("Agent 请求执行：").append(describe(action, arguments)).append("。\n");
        if (action.equals("create_files")) {
            sb.append("将写入的文件：\n");
            List<?> list = arguments.get("list") instanceof List<?> l ? l : List.of();
            int shown = 0;
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> m)) continue;
                sb.append("  - ").append(m.get("path")).append('\n');
                if (++shown >= 20) { sb.append("  …共 ").append(list.size()).append(" 个文件\n"); break; }
            }
        } else if (action.equals("delete_nodes")) {
            sb.append("删除的节点数：").append(nodeIds(arguments).size()).append("（此操作不可撤销，请确认）");
        }
        return sb.toString();
    }

    private static AgentToolResult createNodes(AgentToolContext context, Map<String, Object> arguments) {
        int count = Math.max(1, Math.min(MAX_BATCH, intArg(arguments, "count", 1)));
        String baseName = stringArg(arguments, "name", "节点");
        String category = stringArg(arguments, "category", "基础");
        String prompt = stringArg(arguments, "prompt", "说明这个节点应完成的工作");
        boolean connect = Boolean.TRUE.equals(arguments.get("connect"));
        List<String> ids = new ArrayList<>();
        context.mutateWorkbench(model -> {
            List<WorkflowModel.Node> created = new ArrayList<>();
            for (int i = 0; i < count; i++) {
                WorkflowModel.Node node = model.addNode(120 + (i % 10) * 40, 120 + (i / 10) * 90);
                node.name = count == 1 ? baseName : baseName + (i + 1);
                node.category = category;
                node.prompt = prompt;
                created.add(node);
                ids.add(node.id);
            }
            if (connect) {
                for (int i = 0; i + 1 < created.size(); i++) model.connect(created.get(i), created.get(i + 1));
            }
        });
        context.audit("bulk_edit create_nodes count=" + count);
        return AgentToolResult.ok("已批量创建 " + ids.size() + " 个节点",
            Map.of("action", "create_nodes", "nodeIds", ids, "count", ids.size()));
    }

    @SuppressWarnings("unchecked")
    private static AgentToolResult createFiles(AgentToolContext context, Map<String, Object> arguments) {
        List<?> list = arguments.get("list") instanceof List<?> l ? l : List.of();
        if (list.isEmpty()) return AgentToolResult.error("缺少 list（要写入的文件列表）");
        Path root = context.projectRoot().toAbsolutePath().normalize();
        List<String> written = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        int n = 0;
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m)) continue;
            String relative = String.valueOf(m.get("path")).trim();
            String content = m.get("content") == null ? "" : String.valueOf(m.get("content"));
            if (relative.isBlank()) { errors.add("第 " + (n + 1) + " 项缺 path"); n++; continue; }
            Path target = root.resolve(relative).normalize();
            if (!target.startsWith(root)) { errors.add("路径越过项目边界: " + relative); n++; continue; }
            try {
                if (target.getParent() != null) Files.createDirectories(target.getParent());
                Files.writeString(target, content, StandardCharsets.UTF_8);
                written.add(relative);
            } catch (Exception e) {
                errors.add(relative + ": " + e.getMessage());
            }
            context.notifyFileChange(relative, "create", content.length() + " 字节");
            n++;
        }
        context.audit("bulk_edit create_files written=" + written.size() + " errors=" + errors.size());
        if (written.isEmpty()) return AgentToolResult.error("写入失败：" + String.join("；", errors));
        LinkedHashMap<String, Object> data = new LinkedHashMap<>();
        data.put("action", "create_files");
        data.put("written", written);
        data.put("count", written.size());
        if (!errors.isEmpty()) data.put("errors", errors);
        return AgentToolResult.ok("已批量写入 " + written.size() + " 个文件" + (errors.isEmpty() ? "" : "，失败 " + errors.size() + " 项"), data);
    }

    @SuppressWarnings("unchecked")
    private static AgentToolResult createAssets(AgentToolContext context, Map<String, Object> arguments) {
        List<?> list = arguments.get("list") instanceof List<?> l ? l : List.of();
        if (list.isEmpty()) return AgentToolResult.error("缺少 list（资产列表）");
        List<String> ids = new ArrayList<>();
        context.mutateWorkbench(model -> {
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> m)) continue;
                String relative = String.valueOf(m.get("path")).trim();
                Object at = m.get("assetType");
                String assetType = (at == null ? "image" : String.valueOf(at)).trim();
                if (relative.isBlank()) continue;
                WorkflowModel.Node node = model.addAssetNode(200, 200 + ids.size() * 40, fileName(relative), relative, assetType);
                ids.add(node.id);
            }
        });
        context.audit("bulk_edit create_assets count=" + ids.size());
        return AgentToolResult.ok("已批量创建 " + ids.size() + " 个资产节点",
            Map.of("action", "create_assets", "nodeIds", ids, "count", ids.size()));
    }

    private static AgentToolResult deleteNodes(AgentToolContext context, Map<String, Object> arguments) {
        List<String> ids = nodeIds(arguments);
        if (ids.isEmpty()) return AgentToolResult.error("缺少 nodeIds");
        List<String> deleted = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        context.mutateWorkbench(model -> {
            for (String id : ids) {
                WorkflowModel.Node node = model.byId(id);
                if (node == null) { errors.add("节点不存在: " + id); continue; }
                model.removeNode(node);
                deleted.add(id);
            }
        });
        context.audit("bulk_edit delete_nodes count=" + deleted.size());
        if (deleted.isEmpty()) return AgentToolResult.error("删除失败：" + String.join("；", errors));
        return AgentToolResult.ok("已批量删除 " + deleted.size() + " 个节点" + (errors.isEmpty() ? "" : "，失败 " + errors.size() + " 项"),
            Map.of("action", "delete_nodes", "deleted", deleted, "count", deleted.size()));
    }

    private static int intArg(Map<String, Object> arguments, String key, int fallback) {
        return arguments.get(key) instanceof Number number ? number.intValue() : fallback;
    }

    private static String stringArg(Map<String, Object> arguments, String key, String fallback) {
        Object value = arguments.get(key);
        if (value == null || "null".equals(String.valueOf(value))) return fallback;
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? fallback : text;
    }

    private static int listSize(Map<String, Object> arguments) {
        return arguments.get("list") instanceof List<?> list ? list.size() : 0;
    }

    private static List<String> nodeIds(Map<String, Object> arguments) {
        List<String> ids = new ArrayList<>();
        Object single = arguments.get("nodeId");
        if (single != null && !String.valueOf(single).isBlank()) ids.add(String.valueOf(single));
        Object raw = arguments.get("nodeIds");
        if (raw instanceof List<?> list) {
            for (Object item : list) if (item != null && !String.valueOf(item).isBlank()) ids.add(String.valueOf(item));
        }
        return ids;
    }

    private static String fileName(String relative) {
        int slash = Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\'));
        return slash < 0 ? relative : relative.substring(slash + 1);
    }
}
