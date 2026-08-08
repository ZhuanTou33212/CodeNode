package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.time.Instant;

/**
 * 全量扫描诊断报告：记录每个环节的开始/完成时间与心跳。
 * 提供看门狗线程：若某环节超过 {@code hangTimeout} 未心跳，判定卡死并把
 * 卡死环节与最后心跳时间写入报告文件，便于定位是哪个环节出问题。
 */
public final class ScanDiagnostics {

    private final Path reportFile;
    private final long hangTimeoutMillis;
    private final StringBuilder log = new StringBuilder();
    private volatile String currentStage = "未开始";
    private volatile long lastHeartbeat = System.currentTimeMillis();
    private volatile boolean running;
    private Thread watchdog;

    public ScanDiagnostics(Path projectRoot, long hangTimeoutMillis) {
        this.reportFile = projectRoot.resolve(".codenode/full-scan-diag.log");
        this.hangTimeoutMillis = hangTimeoutMillis;
    }

    /** 记录环节开始。 */
    public void begin(String stage) {
        synchronized (log) {
            log.append("[").append(ts()).append("] BEGIN ").append(stage).append("\n");
        }
        currentStage = stage;
        heartbeat();
    }

    /** 记录环节完成。 */
    public void end(String stage) {
        synchronized (log) {
            log.append("[").append(ts()).append("] END   ").append(stage).append("\n");
        }
        currentStage = "完成:" + stage;
        heartbeat();
    }

    /** 心跳：任何长时间运行环节内周期性调用，防止被误判卡死。 */
    public void heartbeat() {
        lastHeartbeat = System.currentTimeMillis();
    }

    public String currentStage() {
        return currentStage;
    }

    /** 启动看门狗：超过 hangTimeoutMillis 无心跳则写卡死报告并返回 true。 */
    public synchronized void startWatchdog(Runnable onHang) {
        if (watchdog != null) return;
        running = true;
        watchdog = new Thread(() -> {
            while (running) {
                long idle = System.currentTimeMillis() - lastHeartbeat;
                if (idle > hangTimeoutMillis) {
                    synchronized (log) {
                        log.append("[").append(ts()).append("] HANG detected at stage: ")
                                .append(currentStage)
                                .append(" idle=").append(Duration.ofMillis(idle).toSeconds())
                                .append("s\n");
                    }
                    writeReport();
                    if (onHang != null) onHang.run();
                    return;
                }
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
            }
        });
        watchdog.setDaemon(true);
        watchdog.setName("scan-diag-watchdog");
        watchdog.start();
    }

    public synchronized void stopWatchdog() {
        running = false;
        if (watchdog != null) watchdog.interrupt();
        watchdog = null;
    }

    /** 写诊断报告到 <项目目录>/.codenode/full-scan-diag.log。 */
    public void writeReport() {
        try {
            Path parent = reportFile.getParent();
            if (parent != null) Files.createDirectories(parent);
            Files.writeString(reportFile, log.toString(), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException e) {
            // 报告写入失败不阻断主流程
        }
    }

    private static String ts() {
        return java.time.LocalTime.now().withNano(0).toString();
    }
}
