package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.project.BuildRunner;
import local.codenode.project.JavaProject;

/**
 * list_tasks：列出工程可用的构建任务 / Maven 目标。path 缺省使用当前项目目录。
 */
public final class ListTasksTool {
    private ListTasksTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
                "list_tasks",
                "列出项目的构建任务：Gradle 用 gradlew tasks --all（可用 run/runClient/compileJava 等），Maven 返回常用目标列表。" +
                        "path 为项目根目录（缺省当前项目）。",
                Map.of("type", "object",
                        "properties", Map.of("path", Map.of("type", "string", "description", "项目根目录（可选，缺省当前项目）")),
                        "required", java.util.List.of()),
                ListTasksTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String path = String.valueOf(arguments.getOrDefault("path", "")).trim();
        java.nio.file.Path root = path.isBlank() ? context.projectRoot() : java.nio.file.Path.of(path);
        if (root == null || !java.nio.file.Files.isDirectory(root)) {
            return AgentToolResult.error("项目目录不存在: " + root);
        }
        JavaProject.BuildSystem system = JavaProject.discover(root);
        context.audit("list_tasks root=" + root + " system=" + system);
        if (system == JavaProject.BuildSystem.GRADLE) {
            StringBuilder log = new StringBuilder();
            BuildRunner.BuildResult result = BuildRunner.listGradleTasks(root, 120, line -> {
                synchronized (log) {
                    if (log.length() > 12000) return;
                    log.append(line).append('\n');
                }
            });
            List<String> lines = result.tail() == null ? List.of() : result.tail().lines()
                    .filter(l -> l.contains(" - ") && !l.startsWith("  "))
                    .limit(60)
                    .map(String::trim)
                    .toList();
            LinkedHashMap<String, Object> data = new LinkedHashMap<>();
            data.put("system", "GRADLE");
            data.put("tasks", lines);
            return AgentToolResult.ok("Gradle 任务（前 " + lines.size() + " 个）:\n" + String.join("\n", lines), data);
        }
        if (system == JavaProject.BuildSystem.MAVEN) {
            List<String> goals = BuildRunner.listMavenGoals();
            return AgentToolResult.ok("Maven 常用目标:\n" + String.join("\n", goals), Map.of("system", "MAVEN", "tasks", goals));
        }
        return AgentToolResult.error("该工程无 Gradle/Maven 任务（纯 javac 工程直接用 build_project 构建）");
    }
}
