package local.codenode;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/** 验证 ScanDiagnostics 看门狗能检测卡死并写诊断报告。 */
public class ScanDiagnosticsTest {

    @Test
    void watchdogDetectsHangAndWritesReport() throws Exception {
        Path root = Files.createTempDirectory("diag-test");
        try {
            ScanDiagnostics diag = new ScanDiagnostics(root, 2_000); // 2 秒超时
            diag.writeReport();
            diag.begin("测试环节");
            boolean[] hang = {false};
            diag.startWatchdog(() -> hang[0] = true);
            // 不心跳，等待看门狗触发
            Thread.sleep(3_000);
            diag.stopWatchdog();
            assertTrue(hang[0], "看门狗应检测到卡死");
            Path report = root.resolve(".codenode/full-scan-diag.log");
            assertTrue(Files.isRegularFile(report), "应写出诊断报告");
            String content = Files.readString(report);
            assertTrue(content.contains("BEGIN"), "报告应含环节开始记录");
            assertTrue(content.contains("HANG"), "报告应含卡死标记");
            assertTrue(content.contains("测试环节"), "报告应含卡死环节名");
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void heartbeatKeepsWatchdogAlive() throws Exception {
        Path root = Files.createTempDirectory("diag-heartbeat");
        try {
            ScanDiagnostics diag = new ScanDiagnostics(root, 1_000);
            boolean[] hang = {false};
            diag.startWatchdog(() -> hang[0] = true);
            long end = System.currentTimeMillis() + 2_500;
            while (System.currentTimeMillis() < end) {
                diag.heartbeat();
                Thread.sleep(100);
            }
            diag.stopWatchdog();
            assertFalse(hang[0], "有心跳时不应误判卡死");
        } finally {
            deleteRecursive(root);
        }
    }

    private static void deleteRecursive(Path dir) throws Exception {
        if (dir == null || !Files.exists(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(java.util.Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }
}
