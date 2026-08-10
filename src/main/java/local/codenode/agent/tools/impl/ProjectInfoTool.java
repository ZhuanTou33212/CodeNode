package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.Map;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.project.JavaProject;

/**
 * project_info：识别给定（或当前）项目目录的工程信息——构建系统、模块、源集、
 * 主类、MC 加载器与可用 JDK。path 缺省时使用当前项目根。
 */
public final class ProjectInfoTool {
    private ProjectInfoTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
                "project_info",
                "识别项目目录的工程信息：构建系统（Gradle/Maven/纯 Java）、模块列表、源集、含 main 的入口类、" +
                        "Minecraft 模组加载器（Forge/Fabric/NeoForge）与本机可用 JDK。path 缺省使用当前项目目录。",
                Map.of("type", "object",
                        "properties", Map.of("path", Map.of("type", "string", "description", "项目根目录（可选，缺省当前项目）")),
                        "required", java.util.List.of()),
                ProjectInfoTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String path = String.valueOf(arguments.getOrDefault("path", "")).trim();
        java.nio.file.Path root = path.isBlank() ? context.projectRoot() : java.nio.file.Path.of(path);
        if (root == null || !java.nio.file.Files.isDirectory(root)) {
            return AgentToolResult.error("项目目录不存在: " + root);
        }
        Map<String, Object> info = JavaProject.describe(root);
        context.audit("project_info root=" + root);
        StringBuilder text = new StringBuilder();
        text.append("构建系统: ").append(info.get("buildSystem"));
        @SuppressWarnings("unchecked")
        java.util.List<String> modules = (java.util.List<String>) info.getOrDefault("modules", java.util.List.of());
        if (!modules.isEmpty()) text.append("  |  模块: ").append(modules);
        @SuppressWarnings("unchecked")
        java.util.List<String> mains = (java.util.List<String>) info.getOrDefault("mainClasses", java.util.List.of());
        text.append("  |  入口类: ").append(mains.isEmpty() ? "无" : String.join(", ", mains));
        @SuppressWarnings("unchecked")
        Map<String, Object> mc = (Map<String, Object>) info.getOrDefault("minecraft", Map.of());
        text.append("  |  MC 加载器: ").append(mc.getOrDefault("loader", "无"));
        @SuppressWarnings("unchecked")
        java.util.List<String> jdks = (java.util.List<String>) info.getOrDefault("jdks", java.util.List.of());
        if (!jdks.isEmpty()) text.append("  |  可用 JDK: ").append(jdks.size()).append(" 个");
        LinkedHashMap<String, Object> data = new LinkedHashMap<>(info);
        return AgentToolResult.ok(text.toString(), data);
    }
}
