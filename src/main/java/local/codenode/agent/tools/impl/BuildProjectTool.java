package local.codenode.agent.tools.impl;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.project.BuildRunner;

/**
 * build_project：构建项目（Gradle compileJava / Maven compile / 纯 javac），
 * 流式日志回传，编译错误按 文件:行:列 结构化返回。tasks 可选，缺省用默认任务。
 */
public final class BuildProjectTool {
    private BuildProjectTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
                "build_project",
                "构建项目：Gradle 执行 compileJava（或指定 tasks）、Maven 执行 compile（或指定目标）、纯 Java 用 javac 编译。" +
                        "path 为项目根目录（缺省当前项目）；tasks 为要执行的 Gradle 任务或 Maven 目标（可选）；timeoutSeconds 默认 300。",
                Map.of("type", "object",
                        "properties", Map.of(
                                "path", Map.of("type", "string", "description", "项目根目录（可选，缺省当前项目）"),
                                "tasks", Map.of("type", "array", "items", Map.of("type", "string"), "description", "构建任务/目标，如 compileJava、build、test"),
                                "timeoutSeconds", Map.of("type", "integer", "description", "超时秒数，默认 300")),
                        "required", java.util.List.of()),
                BuildProjectTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String path = String.valueOf(arguments.getOrDefault("path", "")).trim();
        java.nio.file.Path root = path.isBlank() ? context.projectRoot() : java.nio.file.Path.of(path);
        if (root == null || !java.nio.file.Files.isDirectory(root)) {
            return AgentToolResult.error("项目目录不存在: " + root);
        }
        List<String> tasks = new ArrayList<>();
        if (arguments.get("tasks") instanceof List<?> list) {
            for (Object item : list) {
                String task = String.valueOf(item).trim();
                if (!task.isBlank()) tasks.add(task);
            }
        }
        long timeout = arguments.get("timeoutSeconds") instanceof Number n ? Math.max(5, n.longValue()) : 300;
        if (!context.confirm(local.codenode.agent.tools.AgentToolContext.ConfirmationLevel.WRITE,
                "构建项目 " + root + "（任务: " + (tasks.isEmpty() ? "默认" : tasks) + "）",
                "执行构建以验证代码可编译。超时 " + timeout + " 秒。")) {
            return AgentToolResult.error("已取消构建");
        }
        StringBuilder log = new StringBuilder();
        BuildRunner.BuildResult result = BuildRunner.build(root, tasks, timeout, line -> {
            synchronized (log) {
                if (log.length() > 8000) return;
                log.append(line).append('\n');
            }
        });
        context.audit("build_project root=" + root + " exit=" + result.exitCode() + " ok=" + result.ok());
        StringBuilder text = new StringBuilder();
        text.append("构建").append(result.ok() ? "成功" : "失败").append(" 退出码=").append(result.exitCode());
        if (result.timedOut()) text.append("（超时强杀）");
        if (!result.errors().isEmpty()) {
            text.append("\n编译错误 ").append(result.errors().size()).append(" 条：");
            for (Map<String, Object> err : result.errors()) {
                text.append("\n  ").append(err.get("file")).append(':').append(err.get("line"))
                        .append(err.get("column") == null || ((Number) err.get("column")).intValue() == 0 ? "" : ":" + err.get("column"))
                        .append("  ").append(err.get("message"));
            }
        }
        LinkedHashMap<String, Object> data = new LinkedHashMap<>();
        data.put("ok", result.ok());
        data.put("exitCode", result.exitCode());
        data.put("timedOut", result.timedOut());
        data.put("errors", result.errors());
        data.put("tail", result.tail() == null ? "" : (result.tail().length() > 4000 ? result.tail().substring(0, 4000) : result.tail()));
        return AgentToolResult.ok(text.toString(), data);
    }
}
