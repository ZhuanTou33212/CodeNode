package local.codenode.project;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * JDK 探测与管理（Stage4.8 4.2）：扫描 JAVA_HOME、常见安装路径、~/.codenode/jdks，
 * 读取 release 文件得到版本号；为工程选择可用的 JDK。
 */
public final class JdkManager {
    private JdkManager() {}

    /** 一个可用的 JDK 安装。 */
    public record JdkInfo(Path home, String version) {}

    /** 探测本机所有可用 JDK，按版本号降序排列。工具目录（默认编译器放置位置）优先。 */
    public static List<JdkInfo> probe() {
        List<Path> candidates = new ArrayList<>();
        // 优先：工具目录下的 JDK（默认编译器放置位置）
        candidates.addAll(ToolLocator.jdks());
        String javaHome = System.getenv("JAVA_HOME");
        if (javaHome != null && !javaHome.isBlank()) {
            candidates.add(Path.of(javaHome));
        }
        for (String base : new String[]{
                "C:\\Program Files\\Java",
                "C:\\Program Files\\Eclipse Adoptium",
                "C:\\Program Files\\Microsoft"}) {
            Path dir = Path.of(base);
            if (Files.isDirectory(dir)) {
                try (var stream = Files.list(dir)) {
                    stream.filter(Files::isDirectory).forEach(candidates::add);
                } catch (IOException ignored) {}
            }
        }
        Path userJdks = Path.of(System.getProperty("user.home"), ".codenode", "jdks");
        if (Files.isDirectory(userJdks)) {
            try (var stream = Files.list(userJdks)) {
                stream.filter(Files::isDirectory).forEach(candidates::add);
            } catch (IOException ignored) {}
        }
        List<JdkInfo> result = new ArrayList<>();
        for (Path candidate : candidates) {
            Path javaBin = candidate.resolve("bin").resolve("java" + (isWindows() ? ".exe" : ""));
            if (!Files.isRegularFile(javaBin)) continue;
            String version = versionOf(candidate);
            if (version == null) continue;
            result.add(new JdkInfo(candidate.toAbsolutePath().normalize(), version));
        }
        result.sort(Comparator.comparing(JdkInfo::version).reversed());
        return List.copyOf(result);
    }

    /** 从 release 文件解析版本号，如 "17.0.12+7"；读取失败返回 null。 */
    public static String versionOf(Path home) {
        try {
            Path release = home.resolve("release");
            if (!Files.isRegularFile(release)) return null;
            for (String line : Files.readAllLines(release, StandardCharsets.UTF_8)) {
                if (!line.startsWith("JAVA_VERSION=")) continue;
                String value = line.substring("JAVA_VERSION=".length()).replace("\"", "").trim();
                if (!value.isBlank()) return value;
            }
            return null;
        } catch (IOException e) {
            return null;
        }
    }

    /** 当前进程使用的 JDK（默认兜底）。 */
    public static Path currentJdk() {
        return Path.of(System.getProperty("java.home", ""));
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }
}
