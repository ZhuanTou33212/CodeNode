package local.codenode;

import java.nio.file.*;
import java.util.*;

/**
 * CLI 测试：对 E:\teaCraft\Minecraft_sourceFile 进行实际扫描验证，
 * 覆盖 scanDirectory / generateDirectoryTree / buildAnalysisRequest + javap .class 反汇编。
 */
public final class TeaCraftScanTest {
    public static void main(String[] args) throws Exception {
        Path root = Path.of("E:\\teaCraft\\Minecraft_sourceFile");
        if (!Files.isDirectory(root)) {
            System.err.println("目录不存在: " + root);
            System.exit(1);
        }

        System.out.println("===== TeaCraft Minecraft_sourceFile 扫描测试 =====");
        System.out.println("目标目录: " + root.toAbsolutePath());
        System.out.println();

        // 1. 扫描
        List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(root);
        System.out.println("扫描完成，共找到 " + files.size() + " 个可分析文件（.class）");
        System.out.println();

        // 2. 前 20 个类名
        System.out.println("===== 前 20 个类名列表 =====");
        int shown = 0;
        for (ProjectAnalysisService.FileMeta f : files) {
            String display = f.name().replace(".class", "");
            System.out.printf("  [%d] %s  (%s)%n", shown + 1, display, f.relativePath());
            shown++;
            if (shown >= 20) break;
        }
        System.out.println();

        // 3. 目录树
        System.out.println("===== 目录树 =====");
        System.out.println(ProjectAnalysisService.generateDirectoryTree(root, files));
        System.out.println();

        // 4. 语言汇总
        Map<String, Object> request = ProjectAnalysisService.buildAnalysisRequest(
            root, Path.of("target/test-state"), files, "teacraft-scan-" + System.currentTimeMillis()
        );
        @SuppressWarnings("unchecked")
        Map<String, Object> langSummary = (Map<String, Object>) request.get("languageSummary");
        System.out.println("===== 语言汇总 =====");
        for (Map.Entry<String, Object> e : langSummary.entrySet()) {
            System.out.println("  " + e.getKey() + ": " + e.getValue() + " 个文件");
        }
        System.out.println();

        // 5. javap 反汇编抽样验证（前 5 个文件）
        System.out.println("===== javap 反汇编抽样（前 5 个 .class 文件）=====");
        int sample = 0;
        for (ProjectAnalysisService.FileMeta f : files) {
            if (sample >= 5) break;
            Path fullPath = root.resolve(f.relativePath());
            try {
                FileContentAnalyzer.FileSummary summary = FileContentAnalyzer.analyzeClassFile(fullPath);
                System.out.println("--- " + f.name() + " ---");
                System.out.println("  类: " + summary.classes);
                System.out.println("  方法: " + summary.functions);
                System.out.println("  字段: " + summary.variables);
                System.out.println();
            } catch (Exception e) {
                System.out.println("--- " + f.name() + " --- 分析失败: " + e.getMessage());
                System.out.println();
            }
            sample++;
        }

        // 6. buildAnalysisRequest 摘要
        System.out.println("===== buildAnalysisRequest 摘要 =====");
        System.out.println("  schemaVersion: " + request.get("schemaVersion"));
        System.out.println("  mode: " + request.get("mode"));
        System.out.println("  totalFiles: " + request.get("totalFiles"));
        System.out.println("  projectRoot: " + request.get("projectRoot"));

        System.out.println();
        System.out.println("===== 测试完成 =====");
        System.exit(0);
    }
}
