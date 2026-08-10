package local.codenode.project;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Java 工程模型（Stage4.8 4.1 JavaProject）：识别构建系统（Gradle/Maven/纯 Java）、
 * 源集、模块、主类。MC 模组工程通过 minecraftInfo() 识别 Forge/Fabric/NeoForge。
 */
public final class JavaProject {

    public enum BuildSystem { GRADLE, MAVEN, PLAIN, UNKNOWN }

    private static final Pattern MAIN_METHOD = Pattern.compile("\\bpublic\\s+static\\s+void\\s+main\\s*\\(\\s*String\\s*\\[\\s*]\\s*\\w*\\s*\\)");
    private static final Pattern PACKAGE_DECL = Pattern.compile("^\\s*package\\s+([\\w.]+)\\s*;");
    private static final Pattern CLASS_DECL = Pattern.compile("(?m)^\\s*(?:public\\s+)?(?:final\\s+)?(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)");

    private JavaProject() {}

    /** 识别工程根目录的构建系统。 */
    public static BuildSystem discover(Path root) {
        if (root == null || !Files.isDirectory(root)) return BuildSystem.UNKNOWN;
        for (String file : new String[]{"settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "gradlew", "gradlew.bat"}) {
            if (Files.isRegularFile(root.resolve(file))) return BuildSystem.GRADLE;
        }
        for (String file : new String[]{"pom.xml", "mvnw", "mvnw.cmd"}) {
            if (Files.isRegularFile(root.resolve(file))) return BuildSystem.MAVEN;
        }
        if (Files.isDirectory(root.resolve("src"))) return BuildSystem.PLAIN;
        return BuildSystem.UNKNOWN;
    }

    /** 源集根目录（src/main/java、src/main/kotlin、src/main/resources、src/test/java）。 */
    public static List<Path> sourceRoots(Path root) {
        List<Path> result = new ArrayList<>();
        if (root == null) return result;
        for (String rel : new String[]{"src/main/java", "src/main/kotlin", "src/test/java"}) {
            Path dir = root.resolve(rel);
            if (Files.isDirectory(dir)) result.add(dir);
        }
        if (result.isEmpty()) {
            Path plain = root.resolve("src");
            if (Files.isDirectory(plain)) result.add(plain);
        }
        return List.copyOf(result);
    }

    /** 多模块列表：解析 settings.gradle 的 include 或 Maven 的 &lt;module&gt;。 */
    public static List<String> modules(Path root) {
        Set<String> result = new LinkedHashSet<>();
        if (root == null) return List.of();
        Path settings = root.resolve("settings.gradle");
        if (Files.isRegularFile(settings)) {
            try {
                Matcher m = Pattern.compile("\\binclude\\s*(?:project\\(\\s*)?['\"]([^'\"]+)['\"]").matcher(Files.readString(settings, StandardCharsets.UTF_8));
                while (m.find()) result.add(m.group(1));
            } catch (IOException ignored) {}
        }
        Path pom = root.resolve("pom.xml");
        if (Files.isRegularFile(pom)) {
            try {
                Matcher m = Pattern.compile("<module>([^<]+)</module>").matcher(Files.readString(pom, StandardCharsets.UTF_8));
                while (m.find()) result.add(m.group(1).trim());
            } catch (IOException ignored) {}
        }
        return List.copyOf(result);
    }

    /** 扫描源集，返回含 main 方法的完全限定类名列表（去重）。 */
    public static List<String> findMainClasses(Path root) {
        Set<String> found = new LinkedHashSet<>();
        for (Path sourceRoot : sourceRoots(root)) {
            collectMainClasses(sourceRoot, found);
        }
        return List.copyOf(found);
    }

    private static void collectMainClasses(Path dir, Set<String> out) {
        if (dir == null || !Files.isDirectory(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".java"))
                    .forEach(p -> {
                        try {
                            String code = Files.readString(p, StandardCharsets.UTF_8);
                            if (!MAIN_METHOD.matcher(code).find()) return;
                            String className = classOf(code);
                            if (className == null) return;
                            String pkg = packageOf(code);
                            String rel = dir.relativize(p).toString().replace('\\', '/');
                            String expected = className + ".java";
                            boolean matchesFile = rel.equals(expected) || rel.endsWith("/" + expected);
                            if (matchesFile) out.add(pkg.isBlank() ? className : pkg + "." + className);
                        } catch (IOException ignored) {}
                    });
        } catch (IOException ignored) {}
    }

    private static String classOf(String code) {
        Matcher m = CLASS_DECL.matcher(code);
        return m.find() ? m.group(1) : null;
    }

    private static String packageOf(String code) {
        Matcher m = PACKAGE_DECL.matcher(code);
        return m.find() ? m.group(1) : "";
    }

    /** MC 模组工程识别（Stage4.8 4.1 minecraftInfo）。 */
    public static Map<String, Object> minecraftInfo(Path root) {
        Map<String, Object> info = new LinkedHashMap<>();
        if (root == null) return info;
        if (Files.isRegularFile(root.resolve("fabric.mod.json"))) {
            info.put("loader", "fabric");
        }
        Path buildGradle = Files.isRegularFile(root.resolve("build.gradle"))
                ? root.resolve("build.gradle") : root.resolve("build.gradle.kts");
        if (Files.isRegularFile(buildGradle)) {
            try {
                String text = Files.readString(buildGradle, StandardCharsets.UTF_8);
                if (text.contains("forge") || text.contains("neoforge")) info.put("loader", "forge/neoforge");
                if (text.contains("fabric") || text.contains("loom")) info.put("loader", "fabric");
            } catch (IOException ignored) {}
        }
        if (info.isEmpty()) info.put("loader", "none");
        return info;
    }

    /** 汇总工程信息（供 UI 与 Agent 工具展示）。 */
    public static Map<String, Object> describe(Path root) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("root", root == null ? "" : root.toAbsolutePath().normalize().toString());
        BuildSystem system = discover(root);
        result.put("buildSystem", system.name());
        result.put("modules", modules(root));
        result.put("sourceRoots", sourceRoots(root).stream().map(p -> p.toString()).toList());
        result.put("mainClasses", findMainClasses(root));
        result.put("minecraft", minecraftInfo(root));
        List<JdkManager.JdkInfo> jdks = JdkManager.probe();
        result.put("jdks", jdks.stream().limit(5).map(JdkManager.JdkInfo::toString).toList());
        if (!jdks.isEmpty()) result.put("selectedJdk", jdks.getFirst().home().toString());
        result.put("toolsDir", ToolLocator.toolsDir().toString());
        Path toolGradle = ToolLocator.gradle();
        result.put("toolsGradle", toolGradle == null ? "" : toolGradle.toString());
        return result;
    }
}
