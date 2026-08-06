package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

/**
 * CLI：跑通完整 Stage4 链路，把 E:\teaCraft\Minecraft_sourceFile 的分析结果
 * 保存为 .cnode 工程文件（CnodeProjectCodec v1.1 格式）。
 *
 * 链路：scanDirectory -> buildAnalysisRequest -> 写 inbox -> processAnalysis
 *      -> ResultService.poll 灌入 WorkflowModel -> CnodeProjectCodec.save
 */
public final class TeaCraftGenProjectTest {
    public static void main(String[] args) throws Exception {
        Path root = Path.of("E:\\teaCraft\\Minecraft_sourceFile");
        if (!Files.isDirectory(root)) {
            System.err.println("目录不存在: " + root);
            System.exit(1);
        }

        // 可选的节点上限，防止 7436 节点全部铺开导致画布卡顿；0 = 全量
        int nodeLimit = 0;
        if (args.length > 0) {
            nodeLimit = Integer.parseInt(args[0]);
        }

        Path stateRoot = Path.of("target/teacraft-gen-state");
        Path resultsRoot = stateRoot.resolve("results");
        Path inboxDir = stateRoot.resolve("queue/inbox/req-teacraft");
        deleteRecursive(stateRoot);
        Files.createDirectories(resultsRoot);
        Files.createDirectories(inboxDir);

        System.out.println("===== 生成 TeaCraft .cnode 工程文件 =====");
        System.out.println("源目录: " + root.toAbsolutePath());

        // 1. 扫描
        List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(root);
        System.out.println("扫描完成: " + files.size() + " 个 .class 文件");
        if (nodeLimit > 0 && files.size() > nodeLimit) {
            files = files.subList(0, nodeLimit);
            System.out.println("按上限抽样: 前 " + nodeLimit + " 个文件（nodeLimit=" + nodeLimit + "）");
        }

        // 2. 构建分析请求并写入 inbox
        Map<String, Object> req = ProjectAnalysisService.buildAnalysisRequest(
                root, stateRoot, files, "req-teacraft");
        Files.writeString(inboxDir.resolve("request.json"), Json.stringify(req), StandardCharsets.UTF_8);
        System.out.println("分析申请已写入: " + inboxDir.resolve("request.json"));

        // 3. 处理分析 -> result.json
        long t0 = System.currentTimeMillis();
        Map<String, Object> result = ProjectAnalysisService.processAnalysis(inboxDir, resultsRoot);
        long t1 = System.currentTimeMillis();
        System.out.println("processAnalysis 完成: status=" + result.get("status")
                + ", 耗时 " + (t1 - t0) + " ms");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> nodes = (List<Map<String, Object>>) result.get("analysisNodes");
        System.out.println("分析节点数: " + nodes.size());

        // 4. 灌入 WorkflowModel
        WorkflowModel model = new WorkflowModel();
        ResultService rs = new ResultService(stateRoot);
        rs.poll(model);
        System.out.println("WorkflowModel 节点数: " + model.nodes().size());

        // 5. 保存 .cnode 工程文件
        Path out = Path.of("E:\\CodeNode\\CodeNode\\output\\TeaCraft_Minecraft_sourceFile.cnode");
        Files.createDirectories(out.getParent());
        CnodeProjectCodec codec = new CnodeProjectCodec();
        CnodeProjectCodec.Metadata meta = new CnodeProjectCodec.Metadata(
                UUID.randomUUID().toString(),
                "TeaCraft_Minecraft_sourceFile",
                Instant.now(),
                new CnodeProjectCodec.Settings(
                        WorkflowModel.Mode.MARKDOWN, "java", "generated", "generated/analysis.md", "", 0, 0, 1.0, null, List.of()));
        codec.save(out, model, meta);
        long size = Files.size(out);
        System.out.println("工程文件已保存: " + out.toAbsolutePath() + " (" + size + " bytes)");

        // 6. 回读验证
        CnodeProjectCodec.Loaded loaded = codec.load(out);
        System.out.println("回读验证: 节点=" + loaded.model().nodes().size()
                + ", name=" + loaded.metadata().name()
                + ", mode=" + loaded.metadata().settings().mode());

        System.out.println("===== 生成完成 =====");
        System.exit(0);
    }

    private static void deleteRecursive(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (IOException ignored) {} });
        }
    }
}
