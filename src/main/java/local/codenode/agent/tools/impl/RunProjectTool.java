package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.project.JavaProject;
import local.codenode.project.RunConfig;
import local.codenode.project.RunLauncher;

/**
 * run_project：按运行配置启动项目——Gradle 任务 / Maven 目标 / 入口类。
 * trace=true 时附加 JFR 实时追踪并返回方法采样摘要。后台运行，可 run_id 停止。
 */
public final class RunProjectTool {
    private RunProjectTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
                "run_project",
                "运行项目：Gradle 任务（如 run/runClient）、Maven 目标（如 exec:java）或指定入口类 mainClass。" +
                        "path 为项目根目录（缺省当前项目）；trace=true 时启动 JFR 实时追踪并返回运行时方法采样摘要；" +
                        "timeoutSeconds 默认 60。",
                Map.of("type", "object",
                        "properties", Map.of(
                                "path", Map.of("type", "string", "description", "项目根目录（可选，缺省当前项目）"),
                                "mainClass", Map.of("type", "string", "description", "入口类全名（纯 Java 工程用）"),
                                "task", Map.of("type", "string", "description", "Gradle 任务名或 Maven 目标（如 run/runClient/exec:java）"),
                                "trace", Map.of("type", "boolean", "description", "是否启动 JFR 实时追踪，默认 false"),
                                "timeoutSeconds", Map.of("type", "integer", "description", "超时秒数，默认 60")),
                        "required", java.util.List.of()),
                RunProjectTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String path = String.valueOf(arguments.getOrDefault("path", "")).trim();
        java.nio.file.Path root = path.isBlank() ? context.projectRoot() : java.nio.file.Path.of(path);
        if (root == null || !java.nio.file.Files.isDirectory(root)) {
            return AgentToolResult.error("项目目录不存在: " + root);
        }
        boolean trace = Boolean.TRUE.equals(arguments.get("trace"));
        long timeout = arguments.get("timeoutSeconds") instanceof Number n ? Math.max(5, Math.min(600, n.longValue())) : 60;
        String mainClass = String.valueOf(arguments.getOrDefault("mainClass", "")).trim();
        String task = String.valueOf(arguments.getOrDefault("task", "")).trim();
        JavaProject.BuildSystem system = JavaProject.discover(root);

        RunConfig config;
        switch (system) {
            case GRADLE -> {
                String t = task.isBlank() ? "run" : task;
                config = new RunConfig(t, RunConfig.Kind.GRADLE_TASK, t, null, null, List.of(), List.of(), root, List.of(), trace);
            }
            case MAVEN -> {
                String t = task.isBlank() ? "exec:java" : task;
                config = new RunConfig(t, RunConfig.Kind.MAVEN_GOAL, t, null, null, List.of(), List.of(), root, List.of(), trace);
            }
            case PLAIN -> {
                if (mainClass.isBlank()) {
                    List<String> mains = JavaProject.findMainClasses(root);
                    if (mains.isEmpty()) return AgentToolResult.error("纯 Java 工程未发现 main，请指定 mainClass 参数");
                    mainClass = mains.getFirst();
                }
                config = new RunConfig(mainClass, RunConfig.Kind.MAIN_CLASS, mainClass, null, null, List.of(), List.of(), root, List.of("compile"), trace);
            }
            default -> {
                return AgentToolResult.error("无法识别的工程类型: " + root);
            }
        }
        if (!context.confirm(local.codenode.agent.tools.AgentToolContext.ConfirmationLevel.HIGH,
                "运行项目 " + root + describe(config),
                "将启动一个程序进程，可能长时间运行或需要资源。超时 " + timeout + " 秒。" +
                        (trace ? " 已开启 JFR 实时追踪。" : ""))) {
            return AgentToolResult.error("已取消运行");
        }
        StringBuilder log = new StringBuilder();
        RunLauncher.RunOutcome outcome = RunLauncher.run(config, timeout, line -> {
            synchronized (log) {
                if (log.length() > 8000) return;
                log.append(line).append('\n');
            }
        });
        context.audit("run_project root=" + root + " kind=" + config.kind() + " exit=" + outcome.exitCode() + " trace=" + trace);
        LinkedHashMap<String, Object> data = new LinkedHashMap<>();
        data.put("ok", outcome.exitCode() == 0);
        data.put("exitCode", outcome.exitCode());
        data.put("timedOut", outcome.timedOut());
        data.put("trace", outcome.trace());
        data.put("output", outcome.output() == null ? "" : (outcome.output().length() > 4000 ? outcome.output().substring(0, 4000) : outcome.output()));
        String text = "运行结束 exitCode=" + outcome.exitCode()
                + (outcome.timedOut() ? "（超时强杀）" : "")
                + (outcome.trace() == null || outcome.trace().isEmpty() ? "" : "  |  追踪: " + traceSummary(outcome.trace()))
                + "\n输出尾部:\n" + data.get("output");
        return AgentToolResult.ok(text, data);
    }

    private static String describe(RunConfig config) {
        return "  [" + config.kind() + "] " + (config.mainClass() == null ? "" : config.mainClass());
    }

    private static String traceSummary(Map<String, Object> trace) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> methods = (List<Map<String, Object>>) trace.get("methods");
        if (methods == null || methods.isEmpty()) return "无方法采样";
        StringBuilder sb = new StringBuilder("方法采样 Top " + Math.min(methods.size(), 5) + ":");
        int i = 0;
        for (Map<String, Object> m : methods) {
            if (i++ >= 5) break;
            sb.append(" ").append(m.get("name")).append("(x").append(m.get("samples")).append(")");
        }
        return sb.toString();
    }
}
