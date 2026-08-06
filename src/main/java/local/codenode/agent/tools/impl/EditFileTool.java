package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;

/**
 * edit_file：精确替换项目文件中的某段文本（oldText→newText），区别于整篇覆盖的 write_file。
 * occurrence 指定第几次出现（1 起），缺省替换全部。修改前需确认并自动备份 .bak。
 */
public final class EditFileTool {

    private EditFileTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "edit_file",
            "精确替换项目文件中的某段文本（oldText→newText）。occurrence 指定第几次出现（1 起），缺省替换全部。"
                + "每次执行前请求用户确认，并自动备份 .bak。",
            Map.of("type", "object",
                "properties", Map.of(
                    "path", Map.of("type", "string", "description", "项目内相对路径"),
                    "oldText", Map.of("type", "string", "description", "要查找的原文（必须精确匹配）"),
                    "newText", Map.of("type", "string", "description", "替换后的文本"),
                    "occurrence", Map.of("type", "integer", "description", "只替换第几次出现，缺省全部")),
                "required", List.of("path", "oldText")),
            EditFileTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String relative = String.valueOf(arguments.getOrDefault("path", "")).trim();
        String oldText = String.valueOf(arguments.getOrDefault("oldText", ""));
        String newText = String.valueOf(arguments.getOrDefault("newText", ""));
        if (relative.isBlank()) return AgentToolResult.error("缺少 path");
        if (oldText.isEmpty()) return AgentToolResult.error("缺少 oldText");
        Path root = context.projectRoot().toAbsolutePath().normalize();
        Path file = root.resolve(relative).normalize();
        if (!file.startsWith(root)) return AgentToolResult.error("路径越过项目边界");
        if (!Files.isRegularFile(file)) return AgentToolResult.error("文件不存在：" + relative);
        int occurrence = arguments.get("occurrence") instanceof Number n ? n.intValue() : 0;
        try {
            String content = Files.readString(file, StandardCharsets.UTF_8);
            if (!content.contains(oldText)) return AgentToolResult.error("文件中未找到目标文本：" + abbreviate(oldText));
            String updated;
            int replaced;
            if (occurrence > 0) {
                int index = indexOfOccurrence(content, oldText, occurrence);
                if (index < 0) return AgentToolResult.error("目标文本第 " + occurrence + " 次出现不存在");
                updated = content.substring(0, index) + newText + content.substring(index + oldText.length());
                replaced = 1;
            } else {
                updated = content.replace(oldText, newText);
                replaced = countOccurrences(content, oldText);
            }
            if (!context.confirm("确认修改文件 " + relative + "（替换 " + replaced + " 处）？")) {
                return AgentToolResult.error("已取消修改");
            }
            if (Files.exists(file)) {
                Files.copy(file, file.resolveSibling(file.getFileName() + ".bak"), StandardCopyOption.REPLACE_EXISTING);
            }
            Files.writeString(file, updated, StandardCharsets.UTF_8);
            context.audit("edit_file " + relative + " replaced=" + replaced);
            return AgentToolResult.ok("已替换 " + replaced + " 处：" + relative,
                Map.of("path", relative, "replaced", replaced));
        } catch (Exception e) {
            return AgentToolResult.error("编辑失败：" + e.getMessage());
        }
    }

    private static int indexOfOccurrence(String content, String needle, int occurrence) {
        int from = 0;
        for (int i = 1; i <= occurrence; i++) {
            int index = content.indexOf(needle, from);
            if (index < 0) return -1;
            if (i == occurrence) return index;
            from = index + needle.length();
        }
        return -1;
    }

    private static int countOccurrences(String content, String needle) {
        int count = 0;
        int from = 0;
        while (true) {
            int index = content.indexOf(needle, from);
            if (index < 0) break;
            count++;
            from = index + needle.length();
        }
        return count;
    }

    private static String abbreviate(String text) {
        String trimmed = text.replace('\n', ' ').trim();
        return trimmed.length() <= 40 ? trimmed : trimmed.substring(0, 40) + "…";
    }
}
