package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.Map;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

/** Full UI action gateway for the embedded Agent. */
public final class UiControlTool {
    private static final java.util.Set<String> ACTIONS = java.util.Set.of("view_all", "focus", "zoom", "pan", "resize", "toggle_panel", "new_content", "switch_tab", "open_document", "close_document", "save_document", "dock_panel", "run_config", "build_project", "run_project", "stop_run", "select_node", "open_menu", "read_ui_state");
    private static final java.util.Set<String> ARGUMENTS = java.util.Set.of("action","nodeId","x","y","zoom","width","height","name","panel","tab","index","path","position","menu","mainClass","buildTask","runTask","trace");
    private UiControlTool() {}
    public static void register(AgentToolRegistry registry) {
        LinkedHashMap<String, Object> properties = new LinkedHashMap<>();
        for (String key : ARGUMENTS) properties.put(key, Map.of("type", key.equals("zoom") ? "number" : key.equals("trace") ? "boolean" : key.matches("x|y|width|height|index") ? "integer" : "string"));
        properties.put("action", Map.of("type", "string", "enum", ACTIONS.stream().sorted().toList()));
        registry.register("ui_control", "操控 CodeNode 界面。action 支持 view_all/focus/zoom/pan/resize/toggle_panel/new_content/switch_tab/open_document/close_document/save_document/dock_panel/run_config/build_project/run_project/stop_run/select_node/open_menu/read_ui_state；涉及路径的动作支持 path 参数。", Map.of("type", "object", "properties", properties, "required", java.util.List.of("action"), "additionalProperties", false), UiControlTool::execute);
    }
    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase();
        if (action.isEmpty()) return AgentToolResult.error("缺少 action");
        if (!ACTIONS.contains(action)) return AgentToolResult.error("未知 UI action：" + action);
        String validation = validate(action, arguments);
        if (validation != null) return AgentToolResult.error(validation);
        if (!context.permissionAllowed("ui")) return AgentToolResult.error("UI 操作总开关已关闭：" + action);
        if (context.toolStopRequested()) return AgentToolResult.error("界面操控已取消");
        AgentToolContext.ConfirmationLevel level = java.util.Set.of("open_document", "close_document", "save_document", "dock_panel", "build_project", "run_project", "open_menu").contains(action)
                ? AgentToolContext.ConfirmationLevel.HIGH : AgentToolContext.ConfirmationLevel.UI;
        String detail = "Agent 请求执行 UI 动作；参数=" + arguments + "；可在 agent.permissions 中配置权限。";
        if (!context.confirm(level, "操控 CodeNode 界面：" + action, detail)) return AgentToolResult.error("UI 操作未获权限：" + action);
        boolean applied = context.ui(action, arguments);
        LinkedHashMap<String, Object> data = new LinkedHashMap<>(); data.put("action", action); data.put("applied", applied);
        if ("read_ui_state".equals(action) && context.softwareInfoProvider() != null) {
            data.putAll(AgentInfoSnapshot.capture(context.softwareInfoProvider()).values());
        }
        if (!applied) return AgentToolResult.error("ui_control 未接线（当前上下文不支持 " + action + "）", data);
        context.audit("ui_control action=" + action);
        return AgentToolResult.ok("已执行界面操控：" + action, data);
    }

    private static String validate(String action, Map<String, Object> arguments) {
        for (String key : arguments.keySet()) if (!ARGUMENTS.contains(key)) return "未知 UI 参数：" + key;
        if (java.util.Set.of("focus", "select_node").contains(action) && blank(arguments, "nodeId")) return action + " 缺少 nodeId";
        if ("toggle_panel".equals(action) && blank(arguments, "panel")) return "toggle_panel 缺少 panel";
        if ("dock_panel".equals(action) && (blank(arguments, "panel") || blank(arguments, "position"))) return "dock_panel 缺少 panel 或 position";
        if (java.util.Set.of("toggle_panel", "dock_panel").contains(action) && !blank(arguments, "panel")
                && !java.util.Set.of("files", "inspector", "output", "error", "changes", "queue", "run", "project_run").contains(String.valueOf(arguments.get("panel")).toLowerCase())) return "未知 panel：" + arguments.get("panel");
        if ("open_menu".equals(action) && blank(arguments, "menu")) return "open_menu 缺少 menu";
        if ("zoom".equals(action) && !(arguments.get("zoom") instanceof Number)) return "zoom 缺少数值 zoom";
        if ("pan".equals(action) && (!(arguments.get("x") instanceof Number) || !(arguments.get("y") instanceof Number))) return "pan 缺少整数 x/y";
        if ("resize".equals(action) && (!(arguments.get("width") instanceof Number) || !(arguments.get("height") instanceof Number))) return "resize 缺少整数 width/height";
        if ("switch_tab".equals(action) && !(arguments.get("index") instanceof Number) && blank(arguments, "tab")) return "switch_tab 缺少 index 或 tab";
        return null;
    }

    private static boolean blank(Map<String, Object> arguments, String key) {
        Object value = arguments.get(key);
        return value == null || String.valueOf(value).isBlank();
    }
}
