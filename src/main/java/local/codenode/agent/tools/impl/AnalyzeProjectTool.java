package local.codenode.agent.tools.impl;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import local.codenode.FileContentAnalyzer;
import local.codenode.ProjectAnalysisService;
import local.codenode.ProjectScanner;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.project.JavaProject;
import local.codenode.project.JdkManager;

/**
 * analyze_project：调用本地软件的工程识别与分析模块（JavaProject / ProjectScanner /
 * ProjectAnalysisService / FileContentAnalyzer）对项目做程序分析，返回结构化结果
 * （构建系统/入口类/JDK/源文件清单/逐文件结构摘要/代码审查发现）。
 * 用户要求"分析文档/分析项目"时调用；Agent 基于返回结果进行后续制作。
 */
public final class AnalyzeProjectTool {
    private AnalyzeProjectTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "analyze_project",
            "调用本地软件的工程识别与分析模块分析项目：返回构建系统（Gradle/Maven/纯Java）、入口类、JDK、"
                + "源文件清单（语言/行数/路径）与逐文件结构摘要（导入/类/函数/变量）。"
                + "path 为项目根目录（缺省当前项目）；analyzeFiles=true（默认）时逐文件提取结构摘要；"
                + "limitFiles 限制最多分析的文件数（默认 200）。用户在要求「分析文档/分析项目」时调用，"
                + "Agent 应基于本工具返回的结构化结果进行后续制作，而不是凭空猜测。",
            Map.of("type", "object",
                "properties", Map.of(
                    "path", Map.of("type", "string", "description", "项目根目录（可选，缺省当前项目）"),
                    "analyzeFiles", Map.of("type", "boolean", "description", "是否逐文件提取结构摘要，默认 true"),
                    "limitFiles", Map.of("type", "integer", "description", "最多分析的文件数，默认 200，上限 1000")),
                "required", List.of()),
            AnalyzeProjectTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String path = String.valueOf(arguments.getOrDefault("path", "")).trim();
        Path root = path.isBlank() ? context.projectRoot() : Path.of(path);
        if (root == null || !Files.isDirectory(root)) {
            return AgentToolResult.error("项目目录不存在: " + root);
        }
        boolean analyzeFiles = !(arguments.get("analyzeFiles") instanceof Boolean b) || b;
        int limit = arguments.get("limitFiles") instanceof Number n
                ? Math.max(1, Math.min(1000, n.intValue())) : 200;
        context.audit("analyze_project root=" + root);
        try {
            // ① 工程识别（本地模块）
            Map<String, Object> info = JavaProject.describe(root);
            // ② 源文件清单
            List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(root);
            List<ProjectScanner.SourceFile> sourceFiles = ProjectScanner.scan(root).sourceFiles();
            // ③ 逐文件结构摘要
            List<Map<String, Object>> fileAnalysis = new ArrayList<>();
            if (analyzeFiles) {
                int analyzed = 0;
                for (ProjectScanner.SourceFile sf : sourceFiles) {
                    if (analyzed >= limit) break;
                    Map<String, Object> entry = summarizeFile(root, sf);
                    if (entry != null) {
                        fileAnalysis.add(entry);
                        analyzed++;
                    }
                }
            }
            LinkedHashMap<String, Object> data = new LinkedHashMap<>();
            data.put("root", root.toAbsolutePath().normalize().toString());
            data.put("buildSystem", info.get("buildSystem"));
            data.put("mainClasses", info.get("mainClasses"));
            data.put("modules", info.get("modules"));
            data.put("jdk", info.get("selectedJdk"));
            data.put("jdks", info.get("jdks"));
            data.put("minecraft", info.get("minecraft"));
            data.put("sourceFileCount", files.size());
            data.put("languageSummary", languageSummary(files));
            data.put("files", files.stream().limit(limit).map(AnalyzeProjectTool::fileMeta).toList());
            if (!fileAnalysis.isEmpty()) data.put("fileAnalysis", fileAnalysis);
            data.put("analyzedFileCount", fileAnalysis.size());
            StringBuilder text = new StringBuilder();
            text.append("工程识别：").append(info.get("buildSystem"))
                    .append("  |  入口类: ").append(((List<?>) info.getOrDefault("mainClasses", List.of())).isEmpty() ? "无" : info.get("mainClasses"))
                    .append("  |  源文件: ").append(files.size());
            if (analyzeFiles) text.append("  |  已分析: ").append(fileAnalysis.size()).append(" 个文件");
            return AgentToolResult.ok(text.toString(), data);
        } catch (Exception e) {
            return AgentToolResult.error("工程分析失败：" + e.getMessage());
        }
    }

    private static Map<String, Object> summarizeFile(Path root, ProjectScanner.SourceFile sf) {
        try {
            Path full = root.resolve(sf.relativePath());
            if (!Files.isRegularFile(full)) return null;
            FileContentAnalyzer.FileSummary summary = FileContentAnalyzer.analyzeFile(full, 200);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("path", sf.relativePath());
            entry.put("language", sf.language());
            entry.put("packageName", sf.packageName());
            entry.put("imports", sf.imports());
            entry.put("classes", summary.classes);
            entry.put("functions", summary.functions);
            entry.put("variables", summary.variables);
            entry.put("lineCount", summary.lineCount);
            return entry;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Map<String, Object> fileMeta(ProjectAnalysisService.FileMeta f) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("relativePath", f.relativePath());
        m.put("name", f.name());
        m.put("language", f.language());
        m.put("ext", f.ext());
        m.put("lineCount", f.lineCount());
        return m;
    }

    private static Map<String, Object> languageSummary(List<ProjectAnalysisService.FileMeta> files) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (ProjectAnalysisService.FileMeta f : files) counts.merge(f.language(), 1, Integer::sum);
        LinkedHashMap<String, Object> summary = new LinkedHashMap<>();
        counts.forEach((lang, count) -> summary.put(lang, count));
        return summary;
    }
}
