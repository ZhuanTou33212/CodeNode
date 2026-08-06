package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** search_files：跨项目文件按正则搜索内容（UTF-8 文本），返回 文件:行:内容。 */
public final class SearchFilesTool {

    private static final long MAX_FILE_BYTES = 2L * 1024 * 1024;

    private SearchFilesTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "search_files",
            "跨项目文件按正则搜索内容（UTF-8 文本），返回 文件:行号:内容。path 限定子目录，filePattern 限定文件 glob，"
                + "caseSensitive 默认 false。",
            Map.of("type", "object",
                "properties", Map.of(
                    "pattern", Map.of("type", "string", "description", "正则表达式"),
                    "path", Map.of("type", "string", "description", "项目内子目录，缺省整个项目"),
                    "filePattern", Map.of("type", "string", "description", "限定文件的 glob，如 *.java"),
                    "maxResults", Map.of("type", "integer", "description", "最多返回条数，默认 100"),
                    "caseSensitive", Map.of("type", "boolean", "description", "是否区分大小写，默认 false")),
                "required", List.of("pattern")),
            SearchFilesTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String patternText = String.valueOf(arguments.getOrDefault("pattern", "")).trim();
        if (patternText.isEmpty()) return AgentToolResult.error("缺少 pattern");
        int max = arguments.get("maxResults") instanceof Number n ? Math.max(1, n.intValue()) : 100;
        boolean caseSensitive = arguments.get("caseSensitive") instanceof Boolean b && b;
        Path root = context.projectRoot().toAbsolutePath().normalize();
        String subDir = String.valueOf(arguments.getOrDefault("path", "")).trim();
        Path start = subDir.isEmpty() ? root : root.resolve(subDir).normalize();
        if (!start.startsWith(root)) return AgentToolResult.error("路径越过项目边界");
        if (!Files.isDirectory(start)) return AgentToolResult.error("目录不存在：" + (subDir.isEmpty() ? "." : subDir));
        Pattern regex;
        try {
            regex = Pattern.compile(patternText, caseSensitive ? 0 : Pattern.CASE_INSENSITIVE);
        } catch (RuntimeException e) {
            return AgentToolResult.error("无效正则：" + e.getMessage());
        }
        String filePattern = String.valueOf(arguments.getOrDefault("filePattern", "")).trim();
        PathMatcher fileFilter = filePattern.isEmpty() ? null
                : FileSystems.getDefault().getPathMatcher("glob:" + filePattern);

        List<String> matches = new ArrayList<>();
        try (Stream<Path> stream = Files.walk(start)) {
            stream.filter(Files::isRegularFile).forEach(file -> {
                if (matches.size() >= max) return;
                if (isSkipped(root, file)) return;
                String relative = root.relativize(file).toString().replace('\\', '/');
                if (fileFilter != null && !fileFilter.matches(root.relativize(file))) return;
                try {
                    if (Files.size(file) > MAX_FILE_BYTES) return;
                    List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
                    for (int i = 0; i < lines.size(); i++) {
                        if (matches.size() >= max) return;
                        if (regex.matcher(lines.get(i)).find()) {
                            matches.add(relative + ":" + (i + 1) + ": " + lines.get(i).trim());
                        }
                    }
                } catch (Exception ignored) {}
            });
        } catch (IOException e) {
            return AgentToolResult.error("搜索失败：" + e.getMessage());
        }
        if (matches.isEmpty()) return AgentToolResult.ok("未找到匹配内容", Map.of("count", 0));
        return AgentToolResult.ok("找到 " + matches.size() + " 处匹配：\n" + String.join("\n", matches),
            Map.of("count", matches.size()));
    }

    private static boolean isSkipped(Path root, Path file) {
        Path current = file.getParent();
        while (current != null && current.startsWith(root) && !current.equals(root)) {
            if (ToolFiles.shouldSkipDir(current)) return true;
            current = current.getParent();
        }
        return ToolFiles.isBinary(file);
    }
}
