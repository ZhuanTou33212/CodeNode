package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** find_files：按 glob 模式在项目内查找文件（跳过构建/缓存目录）。 */
public final class FindFilesTool {

    private FindFilesTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "find_files",
            "按 glob 模式在项目内查找文件，如 **/*.java、assets/**.png。返回相对路径列表。跳过构建/缓存目录。",
            Map.of("type", "object",
                "properties", Map.of(
                    "pattern", Map.of("type", "string", "description", "glob 模式，如 **/*.java"),
                    "maxResults", Map.of("type", "integer", "description", "最多返回条数，默认 100")),
                "required", List.of("pattern")),
            FindFilesTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String pattern = String.valueOf(arguments.getOrDefault("pattern", "")).trim();
        if (pattern.isBlank()) return AgentToolResult.error("缺少 pattern");
        int max = arguments.get("maxResults") instanceof Number n ? Math.max(1, n.intValue()) : 100;
        Path root = context.projectRoot().toAbsolutePath().normalize();
        if (!Files.isDirectory(root)) return AgentToolResult.error("项目目录不存在：" + root);
        PathMatcher matcher;
        try {
            matcher = FileSystems.getDefault().getPathMatcher("glob:" + pattern);
        } catch (RuntimeException e) {
            return AgentToolResult.error("无效的 glob 模式：" + pattern);
        }
        List<String> found = new ArrayList<>();
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    if (!dir.equals(root) && ToolFiles.shouldSkipDir(dir)) return FileVisitResult.SKIP_SUBTREE;
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (found.size() >= max) return FileVisitResult.TERMINATE;
                    String relative = root.relativize(file).toString().replace('\\', '/');
                    if (matcher.matches(root.relativize(file))) found.add(relative);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            return AgentToolResult.error("查找失败：" + e.getMessage());
        }
        if (found.isEmpty()) return AgentToolResult.ok("未找到匹配文件", Map.of("count", 0));
        boolean truncated = found.size() >= max;
        return AgentToolResult.ok("找到 " + found.size() + (truncated ? "+" : "") + " 个文件：\n" + String.join("\n", found),
            Map.of("count", found.size(), "files", found));
    }
}
