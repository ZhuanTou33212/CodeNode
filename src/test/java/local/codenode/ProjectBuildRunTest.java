package local.codenode;

import local.codenode.project.BuildRunner;
import local.codenode.project.JavaProject;
import local.codenode.project.JdkManager;
import local.codenode.project.ProcessRunner;
import local.codenode.project.RunConfig;
import local.codenode.project.TraceCollector;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Stage4.7+4.8 合并验证：工程识别 / 构建运行 / 错误定位 / JFR 追踪摘要。
 */
public class ProjectBuildRunTest {

    private static void deleteRecursive(Path dir) {
        if (dir == null || !Files.exists(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        } catch (Exception ignored) {}
    }

    @Test
    void discoversPlainJavaProjectAndMainClass() throws Exception {
        Path root = Files.createTempDirectory("pj-plain");
        try {
            Path src = root.resolve("src/main/java/demo");
            Files.createDirectories(src);
            Files.writeString(src.resolve("App.java"), """
                package demo;
                public class App {
                    public static void main(String[] args) { System.out.println("hello"); }
                }
                """, StandardCharsets.UTF_8);
            assertEquals(JavaProject.BuildSystem.PLAIN, JavaProject.discover(root));
            assertEquals(List.of("demo.App"), JavaProject.findMainClasses(root));
            assertFalse(JavaProject.sourceRoots(root).isEmpty());
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void discoversGradleAndMavenProject() throws Exception {
        Path gradle = Files.createTempDirectory("pj-gradle");
        try {
            Files.writeString(gradle.resolve("settings.gradle"), "rootProject.name = 'demo'\ninclude 'app'\ninclude 'lib'\n");
            assertEquals(JavaProject.BuildSystem.GRADLE, JavaProject.discover(gradle));
            assertEquals(List.of("app", "lib"), JavaProject.modules(gradle));
        } finally {
            deleteRecursive(gradle);
        }
        Path maven = Files.createTempDirectory("pj-maven");
        try {
            Files.writeString(maven.resolve("pom.xml"), "<project><modules><module>a</module><module>b</module></modules></project>");
            assertEquals(JavaProject.BuildSystem.MAVEN, JavaProject.discover(maven));
            assertEquals(List.of("a", "b"), JavaProject.modules(maven));
        } finally {
            deleteRecursive(maven);
        }
    }

    @Test
    void parseErrorsExtractsFileLineColumn() {
        String output = """
            src/main/java/demo/App.java:5: error: cannot find symbol
            src/main/java/demo/Bad.java:12:10: 错误: 应为 ';'
            random line without pattern
            """;
        List<Map<String, Object>> errors = BuildRunner.parseErrors(output);
        assertEquals(2, errors.size());
        assertEquals("src/main/java/demo/App.java", errors.get(0).get("file"));
        assertEquals(5, ((Number) errors.get(0).get("line")).intValue());
        assertEquals(12, ((Number) errors.get(1).get("line")).intValue());
        assertEquals(10, ((Number) errors.get(1).get("column")).intValue());
    }

    @Test
    void plainProjectCompileAndParseErrors() throws Exception {
        Path root = Files.createTempDirectory("pj-compile");
        try {
            Path src = root.resolve("src/main/java/demo");
            Files.createDirectories(src);
            Files.writeString(src.resolve("App.java"), """
                package demo;
                public class App {
                    public static void main(String[] args) { System.out.println("hi"); }
                }
                """, StandardCharsets.UTF_8);
            List<String> log = new java.util.ArrayList<>();
            BuildRunner.BuildResult result = BuildRunner.build(root, List.of(), 120, log::add);
            assertTrue(result.ok(), "javac 应编译成功: " + result.tail());
            assertTrue(Files.isDirectory(root.resolve("out")));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void processRunnerRunsCommandAndStreams() {
        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java.exe").toString();
        List<String> log = new java.util.ArrayList<>();
        ProcessRunner.RunOutcome outcome = ProcessRunner.run(
                List.of(javaBin, "-version"), Path.of("."), 30, log::add);
        assertEquals(0, outcome.exitCode());
        assertTrue(outcome.tail().contains("openjdk") || outcome.tail().contains("java"), "应输出 JVM 版本");
    }

    @Test
    void runConfigDefaultsAreSafe() {
        Path root = Path.of(".");
        RunConfig config = RunConfig.forMainClass(root, "demo.App");
        assertEquals(RunConfig.Kind.MAIN_CLASS, config.kind());
        assertTrue(config.vmArgs().isEmpty());
        assertTrue(config.programArgs().isEmpty());
        RunConfig gradle = RunConfig.forGradleTask(root, "runClient");
        assertEquals(RunConfig.Kind.GRADLE_TASK, gradle.kind());
        assertEquals("runClient", gradle.mainClass());
    }

    @Test
    void traceCollectorHandlesMissingFile() {
        Map<String, Object> summary = TraceCollector.summarizeJfr(Path.of("does-not-exist.jfr"));
        assertNotNull(summary.get("trace"));
    }

    @Test
    void jdkManagerProbesCurrentJdk() {
        List<JdkManager.JdkInfo> jdks = JdkManager.probe();
        assertFalse(jdks.isEmpty(), "应至少探测到当前 JVM 的 JDK");
        assertNotNull(jdks.getFirst().version());
    }

    @Test
    void toolLocatorPrefersToolsDir() {
        // 工具目录应能被定位（默认编译器放置位置）
        assertTrue(local.codenode.project.ToolLocator.toolsDir().toString().contains("tools"));
        // 工具目录下应能找到 JDK（本机 E:\CodeNode\tools 下有 jdk）
        assertNotNull(local.codenode.project.ToolLocator.jdk(), "工具目录下应能找到 JDK");
        // 工具目录下应能找到 javac
        assertNotNull(local.codenode.project.ToolLocator.javac(), "工具目录下应能找到 javac");
    }

    @Test
    void minecraftInfoDetectsFabric() throws Exception {
        Path root = Files.createTempDirectory("pj-mc");
        try {
            Files.writeString(root.resolve("fabric.mod.json"), "{\"id\":\"demo\"}");
            assertEquals("fabric", JavaProject.minecraftInfo(root).get("loader"));
        } finally {
            deleteRecursive(root);
        }
    }
}
