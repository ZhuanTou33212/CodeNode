package local.codenode.project;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * 子进程运行底层（Stage4.8 4.3 复用 LocalCompiler 思路）：启动命令、流式日志逐行推送、
 * 超时 destroyForcibly、可选终止器。构建/运行/打包/测试共用。
 */
public final class ProcessRunner {
    private ProcessRunner() {}

    public record RunOutcome(int exitCode, boolean timedOut, String tail) {}

    /**
     * 运行命令。dir 为工作目录；logSink 逐行接收 stdout/stderr 合并输出；
     * timeoutSeconds 超时强杀；返回退出码与输出尾部。
     */
    public static RunOutcome run(List<String> command, Path dir, long timeoutSeconds, Consumer<String> logSink) {
        StringBuilder output = new StringBuilder();
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(dir.toFile());
        builder.redirectErrorStream(true);
        Process process = null;
        try {
            process = builder.start();
            final Process runningProcess = process;
            Thread reader = new Thread(() -> pipe(runningProcess.getInputStream(), output, logSink));
            reader.setDaemon(true);
            reader.start();
            boolean finished = process.waitFor(Math.max(5L, timeoutSeconds), TimeUnit.SECONDS);
            int exitCode;
            boolean timedOut = false;
            if (!finished) {
                timedOut = true;
                terminateTree(process);
                process.waitFor(2L, TimeUnit.SECONDS);
                exitCode = -1;
                String msg = "\n…（运行超时 " + timeoutSeconds + " 秒，已强制终止）";
                output.append(msg);
                if (logSink != null) logSink.accept(msg);
            } else {
                exitCode = process.exitValue();
            }
            reader.join(500);
            return new RunOutcome(exitCode, timedOut, output.toString());
        } catch (InterruptedException e) {
            terminateTree(process);
            Thread.currentThread().interrupt();
            String msg = "运行已取消";
            output.append(msg);
            if (logSink != null) logSink.accept(msg);
            return new RunOutcome(-1, false, output.toString());
        } catch (Exception e) {
            terminateTree(process);
            String msg = "启动进程失败: " + e.getMessage();
            output.append(msg);
            if (logSink != null) logSink.accept(msg);
            return new RunOutcome(-1, false, output.toString());
        }
    }

    /** Terminate descendants first so wrapper scripts cannot leave orphaned build/run processes. */
    public static void terminateTree(Process process) {
        if (process == null) return;
        try {
            List<ProcessHandle> descendants = process.toHandle().descendants().toList();
            for (int i = descendants.size() - 1; i >= 0; i--) descendants.get(i).destroyForcibly();
        } catch (Exception ignored) {}
        if (process.isAlive()) process.destroyForcibly();
    }

    /** 子进程输出累计上限（字符）：防失控输出撑爆内存/回传超限（P2-6）。 */
    private static final int MAX_OUTPUT_CHARS = 2_000_000;

    private static void pipe(InputStream in, StringBuilder out, Consumer<String> logSink) {
        try (var stream = in) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = stream.read(buffer)) >= 0) {
                String chunk = new String(buffer, 0, read, StandardCharsets.UTF_8);
                if (out.length() < MAX_OUTPUT_CHARS) {
                    int room = MAX_OUTPUT_CHARS - out.length();
                    out.append(chunk.length() <= room ? chunk : chunk.substring(0, room));
                    if (out.length() >= MAX_OUTPUT_CHARS) {
                        out.append("\n…（输出超过 ").append(MAX_OUTPUT_CHARS).append(" 字符，已截断）");
                    }
                }
                if (logSink != null) {
                    int from = 0;
                    int nl;
                    while ((nl = chunk.indexOf('\n', from)) >= 0) {
                        logSink.accept(chunk.substring(from, nl));
                        from = nl + 1;
                    }
                }
            }
        } catch (IOException ignored) {}
    }

    /** 命令是否在 PATH 中可执行（Windows 附加 .exe/.cmd/.bat）。 */
    public static boolean onPath(String name) {
        String pathVar = System.getenv("PATH");
        if (pathVar == null || pathVar.isBlank()) return false;
        String[] exts = isWindows() ? new String[]{"", ".exe", ".cmd", ".bat"} : new String[]{""};
        for (String dir : pathVar.split(Pattern.quote(File.pathSeparator))) {
            if (dir.isBlank()) continue;
            Path d;
            try {
                d = Path.of(dir);
            } catch (Exception e) {
                continue;
            }
            for (String ext : exts) {
                if (Files.isRegularFile(d.resolve(name + ext))) return true;
            }
        }
        return false;
    }

    /**
     * 在 ~/.gradle/wrapper/dists 下查找已解压的 Gradle 发行版 gradle 可执行文件路径。
     * 用于工程缺 gradle-wrapper.jar 但本地已下载过发行版的情况（按版本号降序取最新）。
     */
    public static String findGradleDistribution() {
        String home = System.getProperty("user.home", "");
        Path dists = Path.of(home, ".gradle", "wrapper", "dists");
        if (!Files.isDirectory(dists)) return null;
        String best = null;
        try (var stream = Files.list(dists)) {
            for (Path dist : stream.toList()) {
                if (!Files.isDirectory(dist)) continue;
                try (var sub = Files.list(dist)) {
                    for (Path hashDir : sub.toList()) {
                        if (!Files.isDirectory(hashDir)) continue;
                        try (var inner = Files.list(hashDir)) {
                            for (Path ver : inner.toList()) {
                                Path bin = ver.resolve("bin").resolve(isWindows() ? "gradle.bat" : "gradle");
                                if (!Files.isRegularFile(bin)) continue;
                                if (best == null || ver.getFileName().toString().compareTo(best) > 0) {
                                    best = bin.toString();
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return best;
    }

    /** 命令是否可执行（Windows 下查找带扩展名的可执行文件）。 */
    public static boolean executable(Path root, String name) {
        Path direct = root.resolve(name);
        if (Files.isRegularFile(direct)) return true;
        Path withExt = root.resolve(name + (isWindows() ? ".bat" : ""));
        if (Files.isRegularFile(withExt)) return true;
        withExt = root.resolve(name + (isWindows() ? ".cmd" : ""));
        return Files.isRegularFile(withExt);
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }
}
