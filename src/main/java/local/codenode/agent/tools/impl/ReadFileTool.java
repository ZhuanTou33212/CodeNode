package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** read_file：项目内文件 UTF-8 读取，超过 maxLines 截断。 */
public final class ReadFileTool {

    private ReadFileTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "read_file",
            "读取项目内文件（UTF-8）。超过 maxLines 行时截断并在末尾标注总行数。",
            Map.of("type", "object",
                "properties", Map.of(
                    "path", Map.of("type", "string", "description", "项目内相对路径"),
                    "maxLines", Map.of("type", "integer", "description", "最多读取行数，默认 200")),
                "required", List.of("path")),
            ReadFileTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String relative = String.valueOf(arguments.getOrDefault("path", "")).trim();
        if (relative.isBlank()) return AgentToolResult.error("缺少 path");
        Path root = context.projectRoot().toAbsolutePath().normalize();
        Path file = root.resolve(relative).normalize();
        if (!file.startsWith(root)) return AgentToolResult.error("路径越过项目边界");
        if (!Files.isRegularFile(file)) return AgentToolResult.error("文件不存在：" + relative);
        int maxLines = arguments.get("maxLines") instanceof Number n ? Math.max(1, n.intValue()) : 200;
        try {
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            boolean truncated = lines.size() > maxLines;
            String content = String.join("\n", lines.subList(0, Math.min(lines.size(), maxLines)));
            String suffix = truncated ? "\n…（截断，共 " + lines.size() + " 行）" : "";
            return AgentToolResult.ok(relative + "（" + lines.size() + " 行）\n" + content + suffix,
                Map.of("path", relative, "lineCount", lines.size(), "truncated", truncated));
        } catch (Exception e) {
            return AgentToolResult.error("读取失败：" + e.getMessage());
        }
    }
}
