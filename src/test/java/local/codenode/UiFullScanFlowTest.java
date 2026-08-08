package local.codenode;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 原生 UI 全量分析流程模拟测试：
 * 逐步复刻「全量扫描」按钮的完整流水线 —— DirectoryGraphBuilder.build →
 * HierarchyLayout.layout → replaceFrom(deepCopy) → refreshFileSpaces →
 * CnodeProjectCodec.save → captureHistory(deepCopy)，对每个环节计时并断言
 * 耗时上限，任何环节卡死都会以测试失败（带阶段名）的方式返回，便于定位。
 *
 * <p>默认使用内置合成工程（assets 资产目录 + src 源码目录 + 若干缓存目录）；
 * 可设系统属性 {@code codenode.scanRoot} 指向真实工程目录做回归。</p>
 */
public class UiFullScanFlowTest {

    private static final long MAX_BUILD_MS = 60_000;
    private static final long MAX_OTHER_STAGE_MS = 20_000;

    @Test
    void fullScanUiFlowStepsCompleteWithinBudget() throws Exception {
        Path root = Path.of(System.getProperty("codenode.scanRoot", "")).toAbsolutePath();
        boolean synthetic = !Files.isDirectory(root);
        if (synthetic) root = syntheticProject();
        try {
            // 1. 扫描建图（含进度回调模拟）
            WorkflowModel result = new WorkflowModel();
            long t0 = System.nanoTime();
            int[] progress = {0};
            DirectoryGraphBuilder.build(result, root, (stage, done, total) -> {
                progress[0]++;
                if (total > 0) assertTrue(done >= 0);
            });
            long buildMs = ms(t0);
            assertTrue(buildMs < MAX_BUILD_MS, "环节[建图]超时 " + buildMs + "ms");
            assertTrue(progress[0] > 0, "进度回调应被调用");
            assertTrue(result.nodes().size() > 0 && result.edges().size() > 0);

            // 2. 布局
            t0 = System.nanoTime();
            HierarchyLayout.layout(result);
            assertTrue(ms(t0) < MAX_OTHER_STAGE_MS, "环节[布局]超时");

            // 3. 写入工作台 replaceFrom = deepCopy + replaceContents（含 recomputeTypes/refreshFileSpaces）
            t0 = System.nanoTime();
            WorkflowModel target = new WorkflowModel();
            target.replaceFrom(result);
            assertTrue(ms(t0) < MAX_OTHER_STAGE_MS, "环节[replaceFrom]超时");
            assertEquals(result.nodes().size(), target.nodes().size());
            assertEquals(result.edges().size(), target.edges().size());

            // 4. 文件空间刷新
            t0 = System.nanoTime();
            target.refreshFileSpaces();
            assertTrue(ms(t0) < MAX_OTHER_STAGE_MS, "环节[refreshFileSpaces]超时");

            // 5. 历史快照 deepCopy
            t0 = System.nanoTime();
            WorkflowModel history = target.deepCopy();
            assertTrue(ms(t0) < MAX_OTHER_STAGE_MS, "环节[历史快照 deepCopy]超时");
            assertEquals(target.nodes().size(), history.nodes().size());

            // 6. 保存 .cnode
            t0 = System.nanoTime();
            Path out = root.resolve("ui-flow-test.cnode");
            CnodeProjectCodec codec = new CnodeProjectCodec();
            CnodeProjectCodec.Metadata meta = new CnodeProjectCodec.Metadata(UUID.randomUUID().toString(),
                    "ui-flow", Instant.now(),
                    new CnodeProjectCodec.Settings(WorkflowModel.Mode.EXECUTABLE, "java", "out", "docs", null, 0, 0, 1.0, null));
            codec.save(out, target, meta);
            assertTrue(ms(t0) < MAX_OTHER_STAGE_MS, "环节[保存 codec.save]超时");
            assertTrue(Files.isRegularFile(out));
            // 读回验证往返
            WorkflowModel loaded = codec.load(out).model();
            assertEquals(target.nodes().size(), loaded.nodes().size());
            Files.deleteIfExists(out);
        } finally {
            if (synthetic) deleteRecursive(root);
        }
    }

    /** 合成工程：资产叶子目录 + 源码目录 + 缓存目录，覆盖各分类路径。 */
    private static Path syntheticProject() throws Exception {
        Path root = Files.createTempDirectory("ui-scan");
        Files.createDirectories(root.resolve("src/main/java/com/demo"));
        Files.createDirectories(root.resolve("assets/demo/models"));
        Files.createDirectories(root.resolve("assets/demo/textures/block"));
        Files.createDirectories(root.resolve("target"));
        Files.createDirectories(root.resolve(".git"));
        for (int i = 0; i < 20; i++) {
            Files.writeString(root.resolve("src/main/java/com/demo/Cls" + i + ".java"),
                    "package com.demo;\npublic class Cls" + i + " {}\n", StandardCharsets.UTF_8);
            Files.writeString(root.resolve("assets/demo/models/model" + i + ".json"),
                    "{\"name\":\"m" + i + "\"}", StandardCharsets.UTF_8);
            Files.writeString(root.resolve("assets/demo/textures/block/stone" + i + ".png"),
                    "x", StandardCharsets.UTF_8);
        }
        Files.writeString(root.resolve("target/out.class"), "x", StandardCharsets.UTF_8);
        Files.writeString(root.resolve(".git/config"), "x", StandardCharsets.UTF_8);
        return root;
    }

    private static long ms(long nanoStart) {
        return (System.nanoTime() - nanoStart) / 1_000_000;
    }

    private static void deleteRecursive(Path dir) throws Exception {
        if (dir == null || !Files.exists(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }
}
