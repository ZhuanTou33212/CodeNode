package local.codenode.project;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * 运行启动器（Stage4.8 4.4 RunLauncher）：按 RunConfig 组装命令并启动子进程，
 * 进程管理（启动/停止/超时强杀/崩溃重启），输出流式推送；trace=true 时附加
 * JFR 记录（Stage4.7 实时运行追踪的外部采样通道）并在结束后收集运行时摘要。
 */
public final class RunLauncher {
    private RunLauncher() {}

    public record RunOutcome(int exitCode, boolean timedOut, String output, Map<String, Object> trace) {}

    /** 一次正在运行的后台进程句柄（IntelliJ 风格：可观察输出、可停止）。 */
    public static final class RunningProcess {
        private final Process process;
        private final Thread reader;
        private final StringBuilder output = new StringBuilder();
        private volatile boolean finished;

        private RunningProcess(Process process, Thread reader) {
            this.process = process;
            this.reader = reader;
        }

        public boolean isAlive() {
            return process != null && process.isAlive();
        }

        public String outputSoFar() {
            return output.toString();
        }

        public boolean finished() {
            return finished;
        }

        public void stop() {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }

        public int exitCode() {
            try {
                return process == null ? -1 : process.exitValue();
            } catch (IllegalThreadStateException e) {
                return -1;
            }
        }
    }

    private static Process currentProcess;
    private static volatile boolean stopRequested;

    /**
     * 非阻塞启动：立即返回，进程后台运行，输出逐段推送给 logSink；
     * 用户可调用 {@link #stop()} 或句柄的 {@link RunningProcess#stop()} 停止。
     * 适合长驻进程（如 Minecraft runClient）。失败时返回 null 并把错误推给 logSink。
     */
    public static RunningProcess launch(RunConfig config, Consumer<String> logSink) {
        List<String> command = buildCommand(config);
        if (command.isEmpty()) {
            if (logSink != null) logSink.accept("运行配置无效");
            return null;
        }
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory((config.workingDir() == null ? Path.of(".") : config.workingDir()).toFile());
        builder.redirectErrorStream(true);
        try {
            Process process = builder.start();
            currentProcess = process;
            stopRequested = false;
            RunningProcess handle = new RunningProcess(process, null);
            Thread reader = new Thread(() -> {
                try (var in = process.getInputStream()) {
                    byte[] buffer = new byte[4096];
                    int read;
                    while ((read = in.read(buffer)) >= 0) {
                        String chunk = new String(buffer, 0, read, StandardCharsets.UTF_8);
                        synchronized (handle.output) {
                            handle.output.append(chunk);
                        }
                        if (logSink != null) logSink.accept(chunk);
                    }
                } catch (Exception ignored) {}
                finally {
                    synchronized (handle) {
                        handle.finished = true;
                        handle.notifyAll();
                    }
                }
            });
            reader.setDaemon(true);
            reader.start();
            return handle;
        } catch (Exception e) {
            String msg = "启动进程失败: " + e.getMessage();
            if (logSink != null) logSink.accept(msg);
            return null;
        }
    }

    /** 阻塞式运行配置；用于需要等待结束的快速任务（纯 Java 入口类）。 */
    public static RunOutcome run(RunConfig config, long timeoutSeconds, Consumer<String> logSink) {
        List<String> command = buildCommand(config);
        if (command.isEmpty()) {
            return new RunOutcome(-1, false, "运行配置无效", Map.of());
        }
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory((config.workingDir() == null ? Path.of(".") : config.workingDir()).toFile());
        builder.redirectErrorStream(true);
        StringBuilder output = new StringBuilder();
        Consumer<String> sink = line -> {
            output.append(line).append('\n');
            if (logSink != null) logSink.accept(line);
        };
        try {
            Process process = builder.start();
            currentProcess = process;
            stopRequested = false;
            Thread reader = new Thread(() -> {
                try (var in = process.getInputStream()) {
                    byte[] buffer = new byte[4096];
                    int read;
                    while ((read = in.read(buffer)) >= 0) {
                        String chunk = new String(buffer, 0, read, StandardCharsets.UTF_8);
                        output.append(chunk);
                        if (logSink != null) logSink.accept(chunk);
                    }
                } catch (Exception ignored) {}
            });
            reader.setDaemon(true);
            reader.start();
            boolean finished = process.waitFor(Math.max(10L, timeoutSeconds), TimeUnit.SECONDS);
            int exitCode;
            boolean timedOut = false;
            if (!finished) {
                timedOut = true;
                process.destroyForcibly();
                process.waitFor(2L, TimeUnit.SECONDS);
                exitCode = -1;
                String msg = "\n…（运行超时 " + timeoutSeconds + " 秒，已强制终止）";
                output.append(msg);
                if (logSink != null) logSink.accept(msg);
            } else {
                exitCode = process.exitValue();
            }
            reader.join(500);
            Map<String, Object> trace = config.trace() ? collectTrace(config, process) : Map.of();
            return new RunOutcome(exitCode, timedOut, output.toString(), trace);
        } catch (Exception e) {
            String msg = "启动进程失败: " + e.getMessage();
            output.append(msg);
            if (logSink != null) logSink.accept(msg);
            return new RunOutcome(-1, false, output.toString(), Map.of());
        } finally {
            currentProcess = null;
        }
    }

    /** 请求停止当前后台进程（阻塞 run 或 launch 的最后一次启动）。 */
    public static void stop() {
        stopRequested = true;
        Process process = currentProcess;
        if (process != null && process.isAlive()) {
            process.destroyForcibly();
        }
    }

    /** 停止指定句柄的后台进程。 */
    public static void stop(RunningProcess handle) {
        if (handle != null) {
            handle.stop();
        }
    }

    public static boolean stopRequested() {
        return stopRequested;
    }

    private static List<String> buildCommand(RunConfig config) {
        List<String> command = new ArrayList<>();
        String java = javaBin(config.jdkHome());
        switch (config.kind()) {
            case MAIN_CLASS -> {
                String classpath = classpathFor(config.workingDir());
                command.add(java);
                command.add("-cp");
                command.add(classpath);
                if (config.trace()) command.add("-XX:StartFlightRecording=filename=" + traceFile(config.workingDir()) + ",settings=profile,dumponexit=true");
                command.addAll(config.vmArgs());
                command.add(config.mainClass() == null ? "" : config.mainClass());
                command.addAll(config.programArgs());
            }
            case JAR_APPLICATION -> {
                command.add(java);
                if (config.trace()) command.add("-XX:StartFlightRecording=filename=" + traceFile(config.workingDir()) + ",settings=profile,dumponexit=true");
                command.addAll(config.vmArgs());
                command.add("-jar");
                command.add(config.jarPath() == null ? "" : config.jarPath());
                command.addAll(config.programArgs());
            }
            case GRADLE_TASK -> {
                List<String> cmd = gradleCommand(config.workingDir());
                if (cmd.isEmpty()) return List.of();
                command.addAll(cmd);
                command.add(config.mainClass() == null ? "run" : config.mainClass());
            }
            case MAVEN_GOAL -> {
                List<String> cmd = mavenCommand(config.workingDir());
                if (cmd.isEmpty()) return List.of();
                command.addAll(cmd);
                command.add("-q");
                command.add(config.mainClass() == null ? "exec:java" : config.mainClass());
            }
        }
        return command;
    }

    /** 组装 Gradle 启动命令：优先 gradlew.bat，其次 sh gradlew（Unix 脚本），再工具目录/本地发行版/系统 gradle。 */
    private static List<String> gradleCommand(Path root) {
        if (root != null) {
            if (Files.isRegularFile(root.resolve("gradlew.bat"))) return List.of("gradlew.bat");
            if (Files.isRegularFile(root.resolve("gradlew"))) {
                // 仅当 wrapper jar 存在时才用 sh gradlew；否则 wrapper 是坏的，直接走工具目录/发行版
                if (Files.isRegularFile(root.resolve("gradle/wrapper/gradle-wrapper.jar"))) {
                    if (isWindows()) return List.of("sh", "gradlew"); // 用 Git Bash 执行 Unix wrapper
                    return List.of("gradlew");
                }
            }
        }
        // 优先工具目录下的 Gradle（默认编译器放置位置）
        Path toolGradle = ToolLocator.gradle();
        if (toolGradle != null) return List.of(toolGradle.toString());
        String dist = ProcessRunner.findGradleDistribution();
        if (dist != null) return List.of(dist);
        if (ProcessRunner.onPath("gradle")) return List.of("gradle");
        return List.of();
    }

    /** 组装 Maven 启动命令：优先 mvnw.cmd，其次 sh mvnw，再工具目录/系统 mvn。 */
    private static List<String> mavenCommand(Path root) {
        if (root != null) {
            if (Files.isRegularFile(root.resolve("mvnw.cmd"))) return List.of("mvnw.cmd");
            if (Files.isRegularFile(root.resolve("mvnw"))) {
                if (isWindows()) return List.of("sh", "mvnw");
                return List.of("mvnw");
            }
        }
        // 优先工具目录下的 Maven（默认编译器放置位置）
        Path toolMaven = ToolLocator.maven();
        if (toolMaven != null) return List.of(toolMaven.toString());
        if (ProcessRunner.onPath("mvn")) return List.of("mvn");
        return List.of();
    }

    /** classpath：out / build/classes/java/main / target/classes + 各 jar。 */
    private static String classpathFor(Path root) {
        if (root == null) return ".";
        List<String> parts = new ArrayList<>();
        for (String dir : new String[]{"out", "build/classes/java/main", "build/classes/kotlin/main", "target/classes"}) {
            Path p = root.resolve(dir);
            if (Files.isDirectory(p)) parts.add(p.toString());
        }
        try (var stream = Files.list(root)) {
            stream.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".jar"))
                    .forEach(p -> parts.add(p.toString()));
        } catch (Exception ignored) {}
        if (parts.isEmpty()) return ".";
        return String.join(";", parts);
    }

    private static String traceFile(Path root) {
        String name = "codenode-trace-" + System.currentTimeMillis() + ".jfr";
        return (root == null ? Path.of(".") : root).resolve(name).toString();
    }

    /** JFR 记录结束后的运行时摘要（Stage4.7 最小实现：方法采样统计）。 */
    private static Map<String, Object> collectTrace(RunConfig config, Process process) {
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            Path traceDir = config.workingDir() == null ? Path.of(".") : config.workingDir();
            Path jfr;
            try (var stream = Files.list(traceDir)) {
                jfr = stream.filter(p -> p.getFileName().toString().startsWith("codenode-trace-") && p.getFileName().toString().endsWith(".jfr"))
                        .findFirst().orElse(null);
            }
            if (jfr == null || !Files.isRegularFile(jfr)) {
                result.put("trace", "未生成 JFR 记录");
                return result;
            }
            Map<String, Object> summary = TraceCollector.summarizeJfr(jfr);
            result.putAll(summary);
            result.put("jfrFile", jfr.toString());
        } catch (Exception e) {
            result.put("traceError", e.getMessage());
        }
        return result;
    }

    private static String javaBin(String jdkHome) {
        Path home;
        if (jdkHome != null && !jdkHome.isBlank()) {
            home = Path.of(jdkHome);
        } else {
            // 优先工具目录下的 JDK（默认编译器放置位置）
            Path toolJdk = ToolLocator.jdk();
            home = toolJdk != null ? toolJdk : Path.of(System.getProperty("java.home", ""));
        }
        return home.resolve("bin").resolve("java" + (isWindows() ? ".exe" : "")).toString();
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }
}
