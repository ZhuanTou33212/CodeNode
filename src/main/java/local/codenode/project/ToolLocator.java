package local.codenode.project;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 工具目录定位（默认编译器放置位置）。
 * 统一从工具目录（默认 {@code E:\CodeNode\tools}）读取 JDK / Gradle / Maven / javac，
 * 软件编译与运行优先使用该目录下的编译器。目录可用环境变量 {@code CODENODE_TOOLS}
 * 或系统属性 {@code codenode.tools} 覆盖。
 */
public final class ToolLocator {
    private ToolLocator() {}

    /** 默认工具目录。 */
    public static Path toolsDir() {
        String prop = System.getProperty("codenode.tools");
        if (prop != null && !prop.isBlank()) return Path.of(prop);
        String env = System.getenv("CODENODE_TOOLS");
        if (env != null && !env.isBlank()) return Path.of(env);
        if (isWindows()) return Path.of("E:\\CodeNode\\tools");
        return Path.of(System.getProperty("user.dir", "."), "tools");
    }

    /** 工具目录下所有 JDK（含 jdk/bin/java.exe 的目录），按版本号降序。 */
    public static List<Path> jdks() {
        List<Path> result = new ArrayList<>();
        Path dir = toolsDir();
        if (!Files.isDirectory(dir)) return result;
        try (var stream = Files.list(dir)) {
            for (Path candidate : stream.toList()) {
                if (!Files.isDirectory(candidate)) continue;
                Path home = candidate.resolve("Contents").resolve("Home");
                if (!Files.isDirectory(home)) home = candidate;
                Path bin = home.resolve("bin").resolve("java" + (isWindows() ? ".exe" : ""));
                if (Files.isRegularFile(bin)) result.add(home);
            }
        } catch (Exception ignored) {}
        result.sort(Comparator.comparing(ToolLocator::version).reversed());
        return List.copyOf(result);
    }

    /** 工具目录下最新 JDK；找不到返回 null。 */
    public static Path jdk() {
        List<Path> jdks = jdks();
        return jdks.isEmpty() ? null : jdks.getFirst();
    }

    /** 工具目录下最新 JDK 的 javac 可执行文件；找不到返回 null。 */
    public static Path javac() {
        Path jdk = jdk();
        if (jdk == null) return null;
        Path javac = jdk.resolve("bin").resolve("javac" + (isWindows() ? ".exe" : ""));
        return Files.isRegularFile(javac) ? javac : null;
    }

    /** 工具目录下最新 JDK 的 java 可执行文件；找不到返回 null。 */
    public static Path java() {
        Path jdk = jdk();
        if (jdk == null) return null;
        Path java = jdk.resolve("bin").resolve("java" + (isWindows() ? ".exe" : ""));
        return Files.isRegularFile(java) ? java : null;
    }

    /** 工具目录下的 Gradle 可执行文件（gradle 目录下 bin/gradle.bat），取最新；找不到返回 null。 */
    public static Path gradle() {
        Path dir = toolsDir();
        if (!Files.isDirectory(dir)) return null;
        Path best = null;
        try (var stream = Files.list(dir)) {
            for (Path candidate : stream.toList()) {
                if (!Files.isDirectory(candidate) || !candidate.getFileName().toString().startsWith("gradle")) continue;
                Path bin = candidate.resolve("bin").resolve(isWindows() ? "gradle.bat" : "gradle");
                if (!Files.isRegularFile(bin)) continue;
                if (best == null || candidate.getFileName().toString().compareTo(best.getFileName().toString()) > 0) {
                    best = bin;
                }
            }
        } catch (Exception ignored) {}
        return best;
    }

    /** 工具目录下的 Maven 可执行文件（maven 目录下 bin/mvn.cmd），找不到返回 null。 */
    public static Path maven() {
        Path dir = toolsDir();
        if (!Files.isDirectory(dir)) return null;
        try (var stream = Files.list(dir)) {
            for (Path candidate : stream.toList()) {
                if (!Files.isDirectory(candidate)) continue;
                String name = candidate.getFileName().toString();
                if (!name.contains("maven") && !name.contains("mvn")) continue;
                Path bin = candidate.resolve("bin").resolve(isWindows() ? "mvn.cmd" : "mvn");
                if (Files.isRegularFile(bin)) return bin;
            }
        } catch (Exception ignored) {}
        return null;
    }

    private static String version(Path jdk) {
        return JdkManager.versionOf(jdk);
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }
}
