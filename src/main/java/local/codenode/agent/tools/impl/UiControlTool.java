package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.Map;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

/** Full UI action gateway for the embedded Agent. */
public final class UiControlTool {
    private UiControlTool() {}
    public static void register(AgentToolRegistry registry) {
        LinkedHashMap<String, Object> properties = new LinkedHashMap<>();
        for (String key : new String[]{"action","nodeId","x","y","zoom","width","height","name","panel","tab","index","path","position","menu"}) properties.put(key, Map.of("type", key.equals("zoom") ? "number" : key.matches("x|y|width|height|index") ? "integer" : "string"));
        registry.register("ui_control", "操控 CodeNode 界面。action 支持 view_all/focus/zoom/pan/resize/toggle_panel/new_content/switch_tab/open_document/close_document/save_document/dock_panel/run_config/build_project/run_project/stop_run/select_node/open_menu/read_ui_state；涉及路径的动作支持 path 参数。", Map.of("type", "object", "properties", properties), UiControlTool::execute);
    }
    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase();
        if (action.isEmpty()) return AgentToolResult.error("缺少 action");
        if (context.toolStopRequested()) return AgentToolResult.error("界面操控已取消");
        if (!context.confirm(AgentToolContext.ConfirmationLevel.UI, "操控 CodeNode 界面：" + action, "Agent 请求执行 UI 动作；可在 agent.permissions 中设置 ui:allow 或 ui:confirm。")) return AgentToolResult.error("UI 操作未获权限：" + action);
        boolean applied = context.ui(action, arguments);
        LinkedHashMap<String, Object> data = new LinkedHashMap<>(); data.put("action", action); data.put("applied", applied);
        if (!applied) return AgentToolResult.error("ui_control 未接线（当前上下文不支持 " + action + "）", data);
        context.audit("ui_control action=" + action);
        return AgentToolResult.ok("已执行界面操控：" + action, data);
    }
}