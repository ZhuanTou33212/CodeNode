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
 * write_file：路径校验 + 写前确认框 + 可选备份 + 审计日志。高危工具每次执行前必须确认。
 */
public final class WriteFileTool {

    private WriteFileTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "write_file",
            "将内容写入项目内文件。每次执行前会请求用户确认；backup=true（默认）时覆盖前自动备份 .bak。",
            Map.of("type", "object",
                "properties", Map.of(
                    "path", Map.of("type", "string", "description", "项目内相对路径"),
                    "content", Map.of("type", "string", "description", "要写入的内容"),
                    "backup", Map.of("type", "boolean", "description", "覆盖前是否备份，默认 true")),
                "required", List.of("path", "content")),
            WriteFileTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String relative = String.valueOf(arguments.getOrDefault("path", "")).trim();
        String content = String.valueOf(arguments.getOrDefault("content", ""));
        if (relative.isBlank()) return AgentToolResult.error("缺少 path");
        Path root = context.projectRoot().toAbsolutePath().normalize();
        Path target = root.resolve(relative).normalize();
        if (!target.startsWith(root)) return AgentToolResult.error("路径越过项目边界");
        if (!context.confirm("确认写入文件 " + relative + "？")) return AgentToolResult.error("已取消写入");
        boolean backup = !(arguments.get("backup") instanceof Boolean b) || b;
        try {
            if (Files.exists(target) && backup) {
                Files.copy(target, target.resolveSibling(target.getFileName() + ".bak"),
                    StandardCopyOption.REPLACE_EXISTING);
            }
            if (target.getParent() != null) Files.createDirectories(target.getParent());
            Files.writeString(target, content, StandardCharsets.UTF_8);
            context.audit("write_file " + relative + " bytes=" + content.length());
            return AgentToolResult.ok("已写入 " + relative + "（" + content.length() + " 字节）",
                Map.of("path", relative, "bytes", content.length()));
        } catch (Exception e) {
            return AgentToolResult.error("写入失败：" + e.getMessage());
        }
    }
}
