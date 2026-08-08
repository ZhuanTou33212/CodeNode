/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import local.codenode.RuntimeTraceService;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

public final class RuntimeTraceTool {
    private RuntimeTraceTool() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("runtime_trace", "实时抓取目标节点作用域内的运行数据：收集用到的代码（程序）与资产，应用内编译并运行，返回目标名称/程序清单（语言/行数/路径）/资产清单/主类/运行输出与退出码。targetId 为目标节点（组/组输出/文件/代码节点）；args 为运行参数；timeoutSeconds 默认 10。", Map.of("type", "object", "properties", Map.of("targetId", Map.of("type", "string", "description", "目标节点 id"), "args", Map.of("type", "array", "items", Map.of("type", "string"), "description", "运行参数"), "timeoutSeconds", Map.of("type", "integer", "description", "超时秒数，默认 10，最多 120"))), RuntimeTraceTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        List<String> list;
        long l;
        String targetId = String.valueOf(arguments.getOrDefault("targetId", "")).trim();
        if (targetId.isBlank()) {
            return AgentToolResult.error("缺少 targetId");
        }
        Object object = arguments.get("timeoutSeconds");
        if (object instanceof Number) {
            Number number = (Number)object;
            l = Math.max(1L, Math.min(120L, number.longValue()));
        } else {
            l = 10L;
        }
        long timeout = l;
        Object object2 = arguments.get("args");
        if (object2 instanceof List) {
            List list2 = (List)object2;
            list = list2.stream().map(String::valueOf).toList();
        } else {
            list = List.of();
        }
        List<String> args = list;
        try {
            Map<String, Object> trace = RuntimeTraceService.trace(context.model(), context.projectRoot(), targetId, args, timeout);
            if (!trace.containsKey("ok")) {
                Object message = trace.get("error");
                return AgentToolResult.error(message == null ? "目标不可用" : String.valueOf(message), trace);
            }
            boolean ok = Boolean.TRUE.equals(trace.get("ok"));
            StringBuilder text = new StringBuilder();
            text.append("目标 `").append(trace.get("targetName")).append("`（").append(trace.get("targetKind")).append("）").append("：程序=").append(trace.get("programs")).append(" 资产=").append(trace.get("assetCount"));
            if (ok) {
                text.append(" 运行成功 exitCode=").append(trace.get("exitCode")).append(" 输出=").append(trace.get("output"));
            } else {
                text.append(" 运行失败 ").append(trace.get("error"));
            }
            context.audit("runtime_trace target=" + targetId + " ok=" + ok);
            LinkedHashMap<String, Object> data = new LinkedHashMap<String, Object>(trace);
            return AgentToolResult.ok(text.toString(), data);
        }
        catch (Exception e) {
            return AgentToolResult.error("实时抓取失败：" + e.getMessage());
        }
    }
}
