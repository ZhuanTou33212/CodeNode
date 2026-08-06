package local.codenode.agent.tools.impl;

import local.codenode.FileContentAnalyzer;
import local.codenode.FileTypeDetector;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * read_file：按文件类型分派读取。
 * <ul>
 *   <li>文本：UTF-8 读取，超过 maxLines 截断，结果自动标注语言；</li>
 *   <li>二进制（.class/.png/.jar/.pdf 等）：拒绝读取，返回 magic bytes 判定的类型与解析建议；</li>
 *   <li>analyze=true：不返回原文，返回结构化摘要（导入/类/函数/变量），适合大文件与快速定位。</li>
 * </ul>
 */
public final class ReadFileTool {

    private ReadFileTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "read_file",
            "读取项目内文本文件（UTF-8，自动检测文件类型；二进制文件拒绝读取并说明解析方法）。" +
            "超过 maxLines 行时截断并标注总行数。analyze=true 时返回结构化摘要（导入/类/函数/变量）而非原文，适合大文件。" +
            "自动按扩展名和 magic bytes 识别语言与类型。",
            Map.of("type", "object",
                "properties", Map.of(
                    "path", Map.of("type", "string", "description", "项目内相对路径"),
                    "maxLines", Map.of("type", "integer", "description", "最多读取行数，默认 200"),
                    "analyze", Map.of("type", "boolean", "description", "true=只返回文件结构摘要（不返回原文），默认 false")),
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
        boolean analyzeOnly = Boolean.TRUE.equals(arguments.get("analyze"));
        int maxLines = arguments.get("maxLines") instanceof Number n ? Math.max(1, n.intValue()) : 200;
        try {
            FileTypeDetector.TypeInfo info = FileTypeDetector.detect(file);
            Map<String, Object> meta = new LinkedHashMap<>();
            meta.put("path", relative);
            meta.put("type", info.description());
            meta.put("binary", !info.text());

            // 二进制：不读内容
            if (!info.text()) {
                return AgentToolResult.error(relative + " 是二进制文件（" + info.description() + "），"
                    + "不能用 read_file 读取；请按建议解析："
                    + binarySuggestion(info), meta);
            }

            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            meta.put("lineCount", lines.size());
            meta.put("language", FileContentAnalyzer.detectLanguage(file.getFileName().toString()));

            // analyze 模式：只返回结构化摘要
            if (analyzeOnly) {
                int maxSummaryLines = arguments.get("maxLines") instanceof Number n2
                        ? Math.max(1, n2.intValue()) : 200;
                FileContentAnalyzer.FileSummary summary = FileContentAnalyzer.analyzeFile(file, maxSummaryLines);
                meta.put("truncated", summary.lineCount > maxSummaryLines);
                return AgentToolResult.ok(relative + "（" + summary.lineCount + " 行，结构摘要）\n" + summary.toPrompt(), meta);
            }

            boolean truncated = lines.size() > maxLines;
            String content = String.join("\n", lines.subList(0, Math.min(lines.size(), maxLines)));
            String suffix = truncated ? "\n…（截断，共 " + lines.size() + " 行）" : "";
            meta.put("truncated", truncated);
            return AgentToolResult.ok(relative + "（" + lines.size() + " 行，"
                + (FileContentAnalyzer.detectLanguage(file.getFileName().toString()).equals("unknown")
                    ? "未知类型" : FileContentAnalyzer.detectLanguage(file.getFileName().toString()))
                + "）\n" + content + suffix, meta);
        } catch (Exception e) {
            return AgentToolResult.error("读取失败：" + e.getMessage());
        }
    }

    private static String binarySuggestion(FileTypeDetector.TypeInfo info) {
        String ext = info.extension().toLowerCase(java.util.Locale.ROOT);
        return switch (ext) {
            case "class" -> "用 execute_shell 执行 javap -p <文件> 反汇编";
            case "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico" -> "图片，需用图像工具查看";
            case "jar", "zip", "cnode" -> "归档，先解压再分析内部条目";
            case "pdf", "docx", "xlsx", "pptx" -> "文档格式，需专用解析器";
            default -> "用 scan_project 或专用工具处理";
        };
    }
}
