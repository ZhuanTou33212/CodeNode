/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.Map;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

public final class UiControlTool {
    private UiControlTool() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("ui_control", "操控 CodeNode 软件本体界面。action 支持：view_all（查看全部节点）；focus（聚焦 nodeId 节点）；zoom（按 zoom 倍率缩放画布）；pan（按 x,y 平移画布）；resize（调整当前窗口大小 width,height）；toggle_panel（切换面板显隐，panel=inspector|output|error|queue）；new_content（在画布新内容 DIY：在 x,y 创建 name 节点）。所有 action 必须在调用方提供 UiAction 时生效，否则返回未接线。", Map.of("type", "object", "properties", Map.of("action", Map.of("type", "string", "description", "view_all/focus/zoom/pan/resize/toggle_panel/new_content"), "nodeId", Map.of("type", "string", "description", "focus 目标节点"), "x", Map.of("type", "integer", "description", "pan/new_content 的 x"), "y", Map.of("type", "integer", "description", "pan/new_content 的 y"), "zoom", Map.of("type", "number", "description", "缩放倍率 0.25~2.5"), "width", Map.of("type", "integer", "description", "resize 宽度"), "height", Map.of("type", "integer", "description", "resize 高度"), "name", Map.of("type", "string", "description", "new_content 节点名称"), "panel", Map.of("type", "string", "description", "toggle_panel 目标面板：inspector/output/error/queue"))), UiControlTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String action = String.valueOf(arguments.getOrDefault("action", "")).trim().toLowerCase();
        if (action.isEmpty()) {
            return AgentToolResult.error("缺少 action");
        }
        boolean applied = context.ui(action, arguments);
        LinkedHashMap<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("action", action);
        data.put("applied", applied);
        if (!applied) {
            return AgentToolResult.error("ui_control 未接线（当前上下文不支持 " + action + "）", data);
        }
        context.audit("ui_control action=" + action);
        return AgentToolResult.ok("已执行界面操控：" + action, data);
    }
}
