/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import local.codenode.LocalCompiler;
import local.codenode.RuntimeTraceService;
import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

public final class CompileRunTool {
    private CompileRunTool() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("compile_run", "应用内编译并运行目标节点作用域内的代码（程序），返回输出/退出码/耗时，不依赖外部 IDE/终端。targetId 为目标节点（组/组输出/文件/代码节点）；mainClass 可指定主类（缺省自动探测含 main 的类）；args 为运行参数列表；timeoutSeconds 为超时秒数（默认 10，最多 120）。sourceFiles 可选：形如 {\"Main.java\":\"源码\"} 的显式源码，指定后忽略工作台目标。", Map.of("type", "object", "properties", Map.of("targetId", Map.of("type", "string", "description", "目标节点 id（组/组输出/文件/代码节点）"), "mainClass", Map.of("type", "string", "description", "主类名，缺省自动探测"), "args", Map.of("type", "array", "items", Map.of("type", "string"), "description", "运行参数"), "timeoutSeconds", Map.of("type", "integer", "description", "超时秒数，默认 10，最多 120"), "sourceFiles", Map.of("type", "object", "description", "可选显式源码映射：相对路径→源码"))), CompileRunTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        Map<String, Object> trace;
        Object rawSources;
        List<String> list;
        long l;
        LinkedHashMap<String, Object> data = new LinkedHashMap<String, Object>();
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
        String mainClass = CompileRunTool.stringArg(arguments, "mainClass", "");
        if (mainClass.isBlank()) {
            mainClass = null;
        }
        if ((rawSources = arguments.get("sourceFiles")) instanceof Map) {
            Map<?, ?> map = (Map<?, ?>)rawSources;
            LinkedHashMap<String, String> sources = new LinkedHashMap<String, String>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                sources.put(String.valueOf(entry.getKey()), entry.getValue() == null ? "" : String.valueOf(entry.getValue()));
            }
            if (mainClass == null || mainClass.isBlank()) {
                mainClass = RuntimeTraceService.findMainClass(sources);
            }
            return CompileRunTool.run(context, sources, mainClass, args, timeout, data, "显式源码");
        }
        String targetId = CompileRunTool.stringArg(arguments, "targetId", "");
        if (targetId.isBlank()) {
            WorkflowModel.Node selected;
            WorkflowModel.Node node = selected = context.model() == null ? null : (WorkflowModel.Node)context.model().nodes().stream().findFirst().orElse(null);
            if (selected == null) {
                return AgentToolResult.error("缺少 targetId 或 sourceFiles");
            }
            targetId = selected.id;
        }
        if (!(trace = RuntimeTraceService.trace(context.model(), context.projectRoot(), targetId, args, timeout)).containsKey("ok")) {
            return AgentToolResult.error(String.valueOf(trace.getOrDefault("error", "目标不可用")), trace);
        }
        data.putAll(trace);
        boolean ok = Boolean.TRUE.equals(trace.get("ok"));
        String text = (ok ? "运行成功" : "运行失败") + "：exitCode=" + String.valueOf(trace.get("exitCode")) + " 耗时=" + String.valueOf(trace.get("durationMs")) + "ms" + (ok ? " 输出=" + String.valueOf(trace.get("output")) : " 错误=" + String.valueOf(trace.get("error")));
        context.audit("compile_run target=" + targetId + " ok=" + ok);
        return ok ? AgentToolResult.ok(text, data) : AgentToolResult.error(text, data);
    }

    private static AgentToolResult run(AgentToolContext context, Map<String, String> sources, String mainClass, List<String> args, long timeout, Map<String, Object> data, String label) {
        LocalCompiler.RunResult result = LocalCompiler.compileAndRun(sources, mainClass, args, timeout);
        data.put("ok", result.ok());
        data.put("compiled", result.compiled());
        data.put("exitCode", result.exitCode());
        data.put("output", result.output());
        data.put("error", result.error());
        data.put("durationMs", result.durationMs());
        data.put("programs", sources.size());
        data.put("mainClass", mainClass == null ? "" : mainClass);
        String text = (result.ok() ? "运行成功" : "运行失败") + "：" + (result.ok() ? result.output() : result.error());
        context.audit("compile_run " + label + " ok=" + result.ok() + " exitCode=" + result.exitCode());
        return result.ok() ? AgentToolResult.ok(text, data) : AgentToolResult.error(text, data);
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
