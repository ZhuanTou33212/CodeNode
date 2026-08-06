package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/** list_directory：列出项目目录内容（Windows 安全，不使用 shell）。 */
public final class ListDirectoryTool {

    private static final int MAX_ENTRIES = 300;

    private ListDirectoryTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "list_directory",
            "列出项目目录内容（Windows 安全，不使用 shell）。path 为项目内相对目录（缺省根目录），recursive=true 递归。",
            Map.of("type", "object",
                "properties", Map.of(
                    "path", Map.of("type", "string", "description", "项目内相对目录，缺省根目录"),
                    "recursive", Map.of("type", "boolean", "description", "是否递归列出，默认 false")),
                "required", List.of()),
            ListDirectoryTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String path = String.valueOf(arguments.getOrDefault("path", "")).trim();
        if (path.isEmpty()) path = ".";
        boolean recursive = arguments.get("recursive") instanceof Boolean b && b;
        Path root = context.projectRoot().toAbsolutePath().normalize();
        Path dir = root.resolve(path).normalize();
        if (!dir.startsWith(root)) return AgentToolResult.error("路径越过项目边界");
        if (!Files.isDirectory(dir)) return AgentToolResult.error("目录不存在：" + path);

        List<String> lines = new ArrayList<>();
        try (Stream<Path> stream = recursive ? Files.walk(dir) : Files.list(dir)) {
            stream.sorted(Comparator.comparing(p -> p.getFileName() == null ? "" : p.getFileName().toString()))
                    .forEach(p -> {
                        if (p.equals(dir)) return;
                        String name = p.getFileName() == null ? p.toString() : p.getFileName().toString();
                        String relative = root.relativize(p).toString().replace('\\', '/');
                        lines.add(Files.isDirectory(p) ? relative + "/" : relative);
                    });
        } catch (Exception e) {
            return AgentToolResult.error("列出失败：" + e.getMessage());
        }
        boolean truncated = lines.size() > MAX_ENTRIES;
        List<String> shown = truncated ? lines.subList(0, MAX_ENTRIES) : lines;
        String header = "目录 " + (path.equals(".") ? "/" : path) + "（" + lines.size() + (truncated ? "+" : "") + " 项）";
        return AgentToolResult.ok(shown.isEmpty() ? header + "（空）" : header + "\n" + String.join("\n", shown),
            Map.of("count", lines.size(), "path", path));
    }
}
