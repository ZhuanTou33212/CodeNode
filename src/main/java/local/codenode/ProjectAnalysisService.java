package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.*;

public final class ProjectAnalysisService {

    private static final Set<String> SOURCE_EXTS = Set.of(
        "java", "kt", "py", "go", "ps1", "ts", "js", "tsx", "jsx", "class"
    );

    private static final Map<String, String> EXT_TO_LANG = Map.ofEntries(
        Map.entry("java", "java"), Map.entry("kt", "kotlin"), Map.entry("py", "python"),
        Map.entry("go", "go"), Map.entry("ps1", "powershell"), Map.entry("ts", "typescript"),
        Map.entry("js", "javascript"), Map.entry("tsx", "typescript"), Map.entry("jsx", "javascript"),
        Map.entry("class", "java")
    );

    public record FileMeta(String relativePath, String name, String language, String ext, int lineCount) {}

    public static List<FileMeta> scanDirectory(Path root) throws IOException {
        List<FileMeta> files = new ArrayList<>();
        try (var stream = Files.walk(root)) {
            stream.filter(Files::isRegularFile).forEach(filePath -> {
                String name = filePath.getFileName().toString();
                int dot = name.lastIndexOf('.');
                if (dot < 0) return;
                String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
                if (!SOURCE_EXTS.contains(ext)) return;
                String language = EXT_TO_LANG.getOrDefault(ext, ext);
                int lineCount;
                if ("class".equals(ext)) {
                    lineCount = 0; // binary .class, use javap for analysis
                } else {
                    try {
                        lineCount = (int) Files.lines(filePath).count();
                    } catch (IOException e) {
                        lineCount = 0;
                    }
                }
                Path relPath = root.relativize(filePath);
                files.add(new FileMeta(relPath.toString().replace('\\', '/'), name, language, ext, lineCount));
            });
        }
        files.sort(Comparator.comparing(FileMeta::relativePath));
        return files;
    }

    public static String generateDirectoryTree(Path root, List<FileMeta> files) {
        StringBuilder tree = new StringBuilder();
        tree.append(root.toAbsolutePath()).append("\n");
        Map<String, List<FileMeta>> byDir = new LinkedHashMap<>();
        for (FileMeta f : files) {
            String dir = f.relativePath.contains("/") ?
                f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) : "";
            byDir.computeIfAbsent(dir, k -> new ArrayList<>()).add(f);
        }
        List<String> dirs = new ArrayList<>(byDir.keySet());
        dirs.sort(Comparator.naturalOrder());
        for (String dir : dirs) {
            if (dir.isEmpty()) {
                for (FileMeta f : byDir.get(dir))
                    tree.append("  ").append(f.name).append(" (").append(f.language).append(", ")
                        .append(f.lineCount).append("行)\n");
            } else {
                tree.append(dir).append("/\n");
                for (FileMeta f : byDir.get(dir))
                    tree.append("  ").append(f.name).append(" (").append(f.language).append(", ")
                        .append(f.lineCount).append("行)\n");
            }
        }
        return tree.toString();
    }

    public static Map<String, Object> buildAnalysisRequest(Path projectDir, Path stateRoot,
            List<FileMeta> files, String requestId) throws IOException {
        List<Map<String, Object>> fileList = new ArrayList<>();
        for (FileMeta f : files) {
            Map<String, Object> fm = new LinkedHashMap<>();
            fm.put("relativePath", f.relativePath);
            fm.put("name", f.name);
            fm.put("language", f.language);
            fm.put("ext", f.ext);
            fm.put("lineCount", f.lineCount);
            fileList.add(fm);
        }
        LinkedHashMap<String, Object> request = new LinkedHashMap<>();
        request.put("schemaVersion", "4.0");
        request.put("requestId", requestId);
        request.put("transport", "local-file-queue");
        request.put("createdAt", Instant.now().toString());
        request.put("mode", "analysis");
        request.put("action", "analyze-project");
        request.put("projectRoot", projectDir.toAbsolutePath().toString());
        request.put("sourceFiles", fileList);
        request.put("totalFiles", files.size());
        request.put("languageSummary", summarizeLanguages(files));
        return request;
    }

    private static Map<String, Object> summarizeLanguages(List<FileMeta> files) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (FileMeta f : files)
            counts.merge(f.language, 1, Integer::sum);
        Map<String, Object> summary = new LinkedHashMap<>();
        for (Map.Entry<String, Integer> e : counts.entrySet())
            summary.put(e.getKey(), e.getValue());
        return summary;
    }

    /**
     * 项目全量解析流水线：Scanner → GraphBuilder → AutoLayout → WorkflowModel。
     * 不改变 scanDirectory(Path)/processAnalysis 的既有签名与 Stage4 依赖。
     *
     * @param root 项目根目录
     * @return 构建完成且已自动布局的 WorkflowModel
     */
    public static WorkflowModel scanProject(Path root) throws IOException {
        ProjectScanner.ScanResult scan = ProjectScanner.scan(root);
        WorkflowModel model = new WorkflowModel();
        ProjectGraphBuilder.build(model, scan, root);
        AutoLayout.layout(model, null);
        return model;
    }

    public static Map<String, Object> processAnalysis(Path requestDir, Path resultsRoot) throws IOException {
        Path requestFile = requestDir.resolve("request.json");
        if (!Files.isRegularFile(requestFile))
            throw new NoSuchFileException("analysis request.json not found: " + requestFile);
        Map<String, Object> request = Json.object(Files.readString(requestFile, StandardCharsets.UTF_8));
        String requestId = String.valueOf(request.get("requestId"));
        String projectRootStr = String.valueOf(request.get("projectRoot"));
        Path projectRoot = Path.of(projectRootStr);

        if (!Files.isDirectory(projectRoot))
            throw new NoSuchFileException("project directory not found: " + projectRoot);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> sourceFiles = (List<Map<String, Object>>) request.get("sourceFiles");

        List<Map<String, Object>> analysisNodes = new ArrayList<>();
        int x = 150, y = 100;
        int col = 0;

        for (Map<String, Object> fm : sourceFiles) {
            String relPath = String.valueOf(fm.get("relativePath"));
            String name = String.valueOf(fm.get("name"));
            String lang = String.valueOf(fm.get("language"));
            int lines = fm.get("lineCount") instanceof Number n ? n.intValue() : 0;

            String prefix = name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name;

            FileContentAnalyzer.FileSummary summary = null;
            Path fullPath = projectRoot.resolve(relPath);
            try {
                if ("class".equals(fm.get("ext"))) {
                    summary = FileContentAnalyzer.analyzeClassFile(fullPath);
                } else {
                    summary = FileContentAnalyzer.analyze(fullPath);
                }
            } catch (Exception ignored) {}

            StringBuilder prompt = new StringBuilder();
            prompt.append("文件: ").append(relPath).append("\n");
            prompt.append("语言: ").append(lang).append("  |  行数: ").append(lines).append("\n");
            if (summary != null) {
                String sp = summary.toPrompt();
                if (!sp.isBlank()) prompt.append(sp);
            }
            prompt.append("\n\n此节点表示项目源文件的分析摘要，Agent 可根据此摘要理解文件结构并生成相关代码。");

            Map<String, Object> node = new LinkedHashMap<>();
            node.put("nodeId", "analysis-" + UUID.randomUUID());
            node.put("name", prefix);
            node.put("nodeKind", "CALCULATION");
            node.put("category", "项目分析");
            node.put("classificationKey", "analysis." + lang);
            node.put("prompt", prompt.toString());
            node.put("artifact", "generated/" + relPath);
            node.put("language", lang);
            node.put("relativePath", relPath);
            node.put("readOnly", true);
            node.put("x", x);
            node.put("y", y);

            List<Map<String, Object>> inputs = new ArrayList<>();
            inputs.add(Map.of("id", "in", "name", "输入", "dataType", "any", "required", false));
            node.put("inputs", inputs);

            List<Map<String, Object>> outputs = new ArrayList<>();
            outputs.add(Map.of("id", "out", "name", "输出", "dataType", "any", "required", false));
            node.put("outputs", outputs);

            analysisNodes.add(node);

            col++;
            if (col >= 5) { col = 0; y += 150; x = 150; }
            else x += 280;
        }

        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("schemaVersion", "4.0");
        result.put("requestId", requestId);
        result.put("mode", "analysis");
        result.put("action", "analyze-project");
        result.put("status", "succeeded");
        result.put("summary", "项目分析完成：共 " + analysisNodes.size() + " 个源文件，已生成分析节点图");
        result.put("projectRoot", projectRootStr);
        result.put("analysisNodes", analysisNodes);
        result.put("totalNodes", analysisNodes.size());
        result.put("processedAt", Instant.now().toString());
        result.put("requiresConfirmation", true);

        Path resultDir = resultsRoot.resolve(requestId);
        Files.createDirectories(resultDir);
        Files.writeString(resultDir.resolve("result.json"), Json.stringify(result),
            StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);

        return result;
    }
}
