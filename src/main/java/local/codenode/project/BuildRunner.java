package local.codenode.project;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 构建执行器（Stage4.8 4.3 BuildRunner）：按工程类型选择 GradleRunner / MavenRunner /
 * JavacRunner，流式日志推送、编译错误定位（文件:行:列）与超时强杀。
 */
public final class BuildRunner {
    private BuildRunner() {}

    public record BuildResult(boolean ok, int exitCode, boolean timedOut,
                              List<Map<String, Object>> errors, String tail) {
        public static BuildResult ok(int exitCode, String tail) {
            return new BuildResult(true, exitCode, false, List.of(), tail);
        }
        public static BuildResult failed(int exitCode, boolean timedOut, List<Map<String, Object>> errors, String tail) {
            return new BuildResult(false, exitCode, timedOut, errors, tail);
        }
    }

    private static final Pattern ERROR_LINE = Pattern.compile(
            "((?:[A-Za-z]:)?[\\\\/\\w.\\-]+\\.\\w+)\\s*:(\\d+)(?::(\\d+))?\\s*:\\s*(?:error|错误|warning[\\s\\[\\]\\w]*)?\\s*(.*)", Pattern.CASE_INSENSITIVE);

    /**
     * 执行构建任务。tasks 为空时用默认任务（PLAIN 直接 javac 编译；Gradle compileJava；Maven compile）。
     */
    public static BuildResult build(Path root, List<String> tasks, long timeoutSeconds, Consumer<String> logSink) {
        if (root == null || !Files.isDirectory(root)) {
            return BuildResult.failed(-1, false, List.of(), "工程目录不存在");
        }
        JavaProject.BuildSystem system = JavaProject.discover(root);
        switch (system) {
            case GRADLE: return gradle(root, tasks, timeoutSeconds, logSink);
            case MAVEN: return maven(root, tasks, timeoutSeconds, logSink);
            case PLAIN: return javac(root, timeoutSeconds, logSink);
            default: return BuildResult.failed(-1, false, List.of(), "无法识别的工程类型（无 build.gradle / pom.xml / src）");
        }
    }

    /** 列出 Gradle 可用任务（gradlew tasks）。 */
    public static BuildResult listGradleTasks(Path root, long timeoutSeconds, Consumer<String> logSink) {
        if (root == null) return BuildResult.failed(-1, false, List.of(), "工程目录不存在");
        List<String> launcher = gradleCommand(root);
        if (launcher.isEmpty()) return BuildResult.failed(-1, false, List.of(), "未找到 gradlew.bat/gradlew（且本地未下载 Gradle 发行版、系统未安装 gradle）");
        List<String> command = new ArrayList<>();
        command.addAll(launcher);
        command.add("tasks");
        command.add("--all");
        return run(root, command, timeoutSeconds, logSink);
    }

    /** 列出 Gradle 可运行任务（runClient/runServer/prepareRunClient 等，含模块前缀）。 */
    public static List<String> listRunTasks(Path root) {
        List<String> result = new ArrayList<>();
        if (root == null) return result;
        List<String> launcher = gradleCommand(root);
        if (launcher.isEmpty()) return result;
        List<String> command = new ArrayList<>();
        command.addAll(launcher);
        command.add("tasks");
        command.add("--all");
        StringBuilder full = new StringBuilder();
        ProcessRunner.RunOutcome outcome = ProcessRunner.run(command, root, 180, line -> {
            synchronized (full) {
                if (full.length() < 200_000) full.append(line).append('\n');
            }
        });
        if (outcome.exitCode() != 0) return result;
        String[] lines = outcome.tail().split("\\r?\\n");
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;
            // 任务行形如：runClient 或 fujian_crops:runClient（tasks --all 会列出带模块前缀的任务名）
            // 过滤掉带描述的任务行（包含 " - " 的说明行、以 - / 开头的行）
            if (trimmed.startsWith("-") || trimmed.startsWith("/")) continue;
            if (trimmed.contains(" - ")) continue;
            String name = trimmed;
            // 匹配真正可运行的 run 类任务（runClient/runServer/runData/runGameTestServer 及模块前缀版），排除 prepareRun*
            String base = name.contains(":") ? name.substring(name.lastIndexOf(':') + 1) : name;
            if (base.startsWith("run") && !base.startsWith("prepare")) {
                result.add(name);
            }
        }
        return List.copyOf(result);
    }

    /** 列出 Maven 可用目标（mvn help:describe 不可靠，改返回常用目标）。 */
    public static List<String> listMavenGoals() {
        return List.of("compile", "test", "package", "clean", "exec:java", "dependency:tree");
    }

    private static BuildResult gradle(Path root, List<String> tasks, long timeoutSeconds, Consumer<String> logSink) {
        List<String> launcher = gradleCommand(root);
        if (launcher.isEmpty()) return BuildResult.failed(-1, false, List.of(), "未找到 gradlew.bat/gradlew（且本地未下载 Gradle 发行版、系统未安装 gradle）。请安装 Gradle 或生成 gradlew.bat");
        List<String> command = new ArrayList<>();
        command.addAll(launcher);
        if (tasks == null || tasks.isEmpty()) {
            command.add("compileJava");
        } else {
            command.addAll(tasks);
        }
        return run(root, command, timeoutSeconds, logSink);
    }

    private static BuildResult maven(Path root, List<String> tasks, long timeoutSeconds, Consumer<String> logSink) {
        List<String> launcher = mavenCommand(root);
        if (launcher.isEmpty()) return BuildResult.failed(-1, false, List.of(), "未找到 mvnw.cmd/mvnw（且系统未安装 mvn）");
        List<String> command = new ArrayList<>();
        command.addAll(launcher);
        command.add("-q");
        if (tasks == null || tasks.isEmpty()) {
            command.add("compile");
        } else {
            command.addAll(tasks);
        }
        return run(root, command, timeoutSeconds, logSink);
    }

    private static BuildResult javac(Path root, long timeoutSeconds, Consumer<String> logSink) {
        List<Path> sources = collectSources(root);
        if (sources.isEmpty()) {
            return BuildResult.failed(-1, false, List.of(), "src 下没有 .java 源文件");
        }
        Path out = root.resolve("out");
        try {
            Files.createDirectories(out);
        } catch (Exception e) {
            return BuildResult.failed(-1, false, List.of(), "无法创建输出目录 out: " + e.getMessage());
        }
        List<String> command = new ArrayList<>();
        command.add(javacBin());
        command.add("-encoding");
        command.add("UTF-8");
        command.add("-d");
        command.add(out.toString());
        for (Path source : sources) command.add(source.toString());
        return run(root, command, timeoutSeconds, logSink);
    }

    private static BuildResult run(Path root, List<String> command, long timeoutSeconds, Consumer<String> logSink) {
        StringBuilder full = new StringBuilder();
        Consumer<String> sink = line -> {
            full.append(line).append('\n');
            if (logSink != null) logSink.accept(line);
        };
        ProcessRunner.RunOutcome outcome = ProcessRunner.run(command, root, timeoutSeconds, sink);
        List<Map<String, Object>> errors = parseErrors(full.toString());
        boolean ok = outcome.exitCode() == 0 && errors.isEmpty();
        if (ok) {
            return BuildResult.ok(outcome.exitCode(), outcome.tail());
        }
        return BuildResult.failed(outcome.exitCode(), outcome.timedOut(), errors, outcome.tail());
    }

    /** 从编译输出中提取 文件:行(:列) 错误列表。 */
    public static List<Map<String, Object>> parseErrors(String output) {
        List<Map<String, Object>> errors = new ArrayList<>();
        if (output == null || output.isBlank()) return errors;
        for (String line : output.split("\\r?\\n")) {
            if (line.isBlank()) continue;
            Matcher m = ERROR_LINE.matcher(line);
            if (!m.find()) continue;
            Map<String, Object> entry = new java.util.LinkedHashMap<>();
            entry.put("file", m.group(1));
            entry.put("line", safeInt(m.group(2)));
            entry.put("column", safeInt(m.group(3)));
            entry.put("message", m.group(4) == null ? "" : m.group(4).trim());
            errors.add(entry);
            if (errors.size() >= 200) break;
        }
        return errors;
    }

    private static int safeInt(String value) {
        try { return value == null ? 0 : Integer.parseInt(value.trim()); }
        catch (NumberFormatException e) { return 0; }
    }

    private static List<Path> collectSources(Path root) {
        List<Path> sources = new ArrayList<>();
        for (Path sourceRoot : JavaProject.sourceRoots(root)) {
            try (var stream = Files.walk(sourceRoot)) {
                stream.filter(Files::isRegularFile)
                        .filter(p -> p.getFileName().toString().endsWith(".java"))
                        .forEach(sources::add);
            } catch (Exception ignored) {}
        }
        return sources;
    }

    private static List<String> gradleCommand(Path root) {
        if (root != null) {
            if (Files.isRegularFile(root.resolve("gradlew.bat"))) return List.of("gradlew.bat");
            if (Files.isRegularFile(root.resolve("gradlew"))) {
                // 仅当 wrapper jar 存在时才用 sh gradlew；否则 wrapper 是坏的，直接走工具目录/发行版
                if (Files.isRegularFile(root.resolve("gradle/wrapper/gradle-wrapper.jar"))) {
                    if (isWindows()) return List.of("sh", "gradlew");
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

    private static String javacBin() {
        // 优先工具目录下的 JDK javac（默认编译器放置位置）
        Path toolJavac = ToolLocator.javac();
        if (toolJavac != null) return toolJavac.toString();
        String home = System.getProperty("java.home", "");
        return Path.of(home, "bin", "javac" + (isWindows() ? ".exe" : "")).toString();
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }
}
