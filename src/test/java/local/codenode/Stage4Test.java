package local.codenode;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class Stage4Test {
    private Path tempDir;

    @BeforeEach
    void setUp() throws IOException {
        tempDir = Files.createTempDirectory("stage4-test-");
    }

    @AfterEach
    void tearDown() throws IOException {
        deleteRecursive(tempDir);
    }

    @Test
    void scanDirectoryFindsSourceFiles() throws IOException {
        Files.createDirectories(tempDir.resolve("src/main/java"));
        Files.createDirectories(tempDir.resolve("scripts"));
        Files.writeString(tempDir.resolve("src/main/java/Main.java"), "public class Main {}", StandardCharsets.UTF_8);
        Files.writeString(tempDir.resolve("scripts/util.py"), "def foo(): pass", StandardCharsets.UTF_8);
        Files.writeString(tempDir.resolve("README.md"), "# Readme", StandardCharsets.UTF_8);
        Files.writeString(tempDir.resolve("config.xml"), "<config/>", StandardCharsets.UTF_8);

        List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(tempDir);
        assertEquals(2, files.size(), "Should find 2 source files");
        assertTrue(files.stream().anyMatch(f -> f.name().equals("Main.java") && "java".equals(f.language())));
        assertTrue(files.stream().anyMatch(f -> f.name().equals("util.py") && "python".equals(f.language())));
    }

    @Test
    void scanDirectoryFiltersNonSource() throws IOException {
        Files.createDirectories(tempDir.resolve("docs"));
        Files.writeString(tempDir.resolve("docs/README.md"), "# Readme", StandardCharsets.UTF_8);
        Files.writeString(tempDir.resolve("config.xml"), "<config/>", StandardCharsets.UTF_8);
        Files.writeString(tempDir.resolve("Main.java"), "class X{}", StandardCharsets.UTF_8);

        List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(tempDir);
        assertEquals(1, files.size());
        assertEquals("Main.java", files.get(0).name());
    }

    @Test
    void lineCountAccurate() throws IOException {
        Files.writeString(tempDir.resolve("Multi.java"), "line1\nline2\nline3\nline4\nline5\n",
                StandardCharsets.UTF_8);
        List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(tempDir);
        ProjectAnalysisService.FileMeta m = files.stream()
                .filter(f -> f.name().equals("Multi.java")).findFirst().orElseThrow();
        assertEquals(5, m.lineCount());
    }

    @Test
    void directoryTreeStructure() throws IOException {
        Files.createDirectories(tempDir.resolve("src/main/java"));
        Files.createDirectories(tempDir.resolve("scripts"));
        Files.writeString(tempDir.resolve("src/main/java/Main.java"), "x", StandardCharsets.UTF_8);
        Files.writeString(tempDir.resolve("scripts/util.py"), "x", StandardCharsets.UTF_8);
        List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(tempDir);
        String tree = ProjectAnalysisService.generateDirectoryTree(tempDir, files);
        assertTrue(tree.contains("src/main/java/"));
        assertTrue(tree.contains("Main.java"));
        assertTrue(tree.contains("scripts/"));
        assertTrue(tree.contains("util.py"));
    }

    @Test
    void buildAnalysisRequestValid() throws IOException {
        Files.writeString(tempDir.resolve("Test.java"), "class T{}", StandardCharsets.UTF_8);
        List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(tempDir);
        Map<String, Object> req = ProjectAnalysisService.buildAnalysisRequest(tempDir, tempDir, files, "req-001");
        assertEquals("4.0", req.get("schemaVersion"));
        assertEquals("analysis", req.get("mode"));
        assertEquals("analyze-project", req.get("action"));
        assertInstanceOf(List.class, req.get("sourceFiles"));
    }

    @Test
    void processAnalysisGeneratesResult() throws IOException {
        Path stateRoot = Files.createTempDirectory("stage4-state-");
        try {
            Files.createDirectories(stateRoot.resolve("results"));
            Path inboxDir = stateRoot.resolve("queue/inbox/req-002");
            Files.createDirectories(inboxDir);
            Files.writeString(tempDir.resolve("Test.java"), "class T{}", StandardCharsets.UTF_8);
            List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(tempDir);
            Map<String, Object> req = ProjectAnalysisService.buildAnalysisRequest(tempDir, stateRoot, files, "req-002");
            Files.writeString(inboxDir.resolve("request.json"), Json.stringify(req), StandardCharsets.UTF_8);

            Map<String, Object> result = ProjectAnalysisService.processAnalysis(inboxDir, stateRoot.resolve("results"));
            assertEquals("succeeded", result.get("status"));
            assertInstanceOf(List.class, result.get("analysisNodes"));
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> nodes = (List<Map<String, Object>>) result.get("analysisNodes");
            assertFalse(nodes.isEmpty());
            Map<String, Object> first = nodes.get(0);
            assertNotNull(first.get("nodeId"));
            assertNotNull(first.get("name"));
            assertEquals("CALCULATION", first.get("nodeKind"));
            assertEquals(Boolean.TRUE, first.get("readOnly"));

            Path resultFile = stateRoot.resolve("results/req-002/result.json");
            assertTrue(Files.isRegularFile(resultFile));
        } finally {
            deleteRecursive(stateRoot);
        }
    }

    @Test
    void pollAppliesAnalysisNodes() throws IOException {
        Path stateRoot = Files.createTempDirectory("stage4-state-");
        try {
            for (String s : List.of("results", "queue/inbox/req-003", "queue/completed",
                    "queue/failed", "queue/cancelled", "queue/rejected", "queue/conflicted")) {
                Files.createDirectories(stateRoot.resolve(s));
            }

            Path resultsDir = stateRoot.resolve("results/req-003");
            Files.createDirectories(resultsDir);
            Map<String, Object> resultObj = new LinkedHashMap<>();
            resultObj.put("schemaVersion", "4.0");
            resultObj.put("requestId", "req-003");
            resultObj.put("mode", "analysis");
            resultObj.put("status", "succeeded");
            resultObj.put("summary", "Test");

            List<Map<String, Object>> nodes = new ArrayList<>();
            Map<String, Object> n1 = new LinkedHashMap<>();
            n1.put("nodeId", "uuid-001");
            n1.put("name", "TestNode");
            n1.put("nodeKind", "CALCULATION");
            n1.put("category", "analysis");
            n1.put("classificationKey", "analysis.java");
            n1.put("prompt", "p");
            n1.put("artifact", "g/T.java");
            n1.put("relativePath", "T.java");
            n1.put("language", "java");
            n1.put("readOnly", true);
            n1.put("x", 100);
            n1.put("y", 200);
            n1.put("inputs", List.of(Map.of("id", "in", "name", "in", "dataType", "any", "required", false)));
            n1.put("outputs", List.of(Map.of("id", "out", "name", "out", "dataType", "any", "required", false)));
            nodes.add(n1);
            resultObj.put("analysisNodes", nodes);
            Files.writeString(resultsDir.resolve("result.json"), Json.stringify(resultObj), StandardCharsets.UTF_8);

            WorkflowModel model = new WorkflowModel();
            ResultService rs = new ResultService(stateRoot);
            rs.poll(model);

            assertEquals(1, model.nodes().size());
            WorkflowModel.Node node = model.nodes().get(0);
            assertEquals("uuid-001", node.id);
            assertEquals("TestNode", node.name);
            assertTrue(node.readOnly);
            assertEquals(WorkflowModel.NodeKind.CALCULATION, node.nodeKind);
            assertEquals(1, node.outputs.size());
            assertEquals("out", node.outputs.get(0).id);
        } finally {
            deleteRecursive(stateRoot);
        }
    }

    @Test
    void duplicateNodeIdsUpdateInPlace() throws IOException {
        Path stateRoot = Files.createTempDirectory("stage4-state-");
        try {
            for (String s : List.of("results", "queue/inbox/req-004", "queue/completed",
                    "queue/failed", "queue/cancelled", "queue/rejected", "queue/conflicted")) {
                Files.createDirectories(stateRoot.resolve(s));
            }

            WorkflowModel model = new WorkflowModel();
            model.forceAddNode("uuid-001", "OldNode", 50, 50);
            WorkflowModel.Node existing = model.byId("uuid-001");
            existing.nodeKind = WorkflowModel.NodeKind.REGULAR;
            existing.readOnly = false;

            Path resultsDir = stateRoot.resolve("results/req-004");
            Files.createDirectories(resultsDir);
            Map<String, Object> resultObj = new LinkedHashMap<>();
            resultObj.put("schemaVersion", "4.0");
            resultObj.put("requestId", "req-004");
            resultObj.put("mode", "analysis");
            resultObj.put("status", "succeeded");
            resultObj.put("summary", "Test");

            List<Map<String, Object>> nodes = new ArrayList<>();
            Map<String, Object> n1 = new LinkedHashMap<>();
            n1.put("nodeId", "uuid-001");
            n1.put("name", "UpdatedNode");
            n1.put("nodeKind", "CALCULATION");
            n1.put("category", "analysis");
            n1.put("classificationKey", "analysis.java");
            n1.put("prompt", "Updated");
            n1.put("artifact", "g/U.java");
            n1.put("relativePath", "U.java");
            n1.put("language", "java");
            n1.put("readOnly", true);
            n1.put("x", 100);
            n1.put("y", 200);
            n1.put("inputs", List.of(Map.of("id", "in", "name", "in", "dataType", "any", "required", false)));
            n1.put("outputs", List.of(Map.of("id", "out", "name", "out", "dataType", "any", "required", false)));
            nodes.add(n1);
            resultObj.put("analysisNodes", nodes);
            Files.writeString(resultsDir.resolve("result.json"), Json.stringify(resultObj), StandardCharsets.UTF_8);

            ResultService rs = new ResultService(stateRoot);
            rs.poll(model);

            assertEquals(1, model.nodes().size());
            WorkflowModel.Node node = model.nodes().get(0);
            assertEquals("UpdatedNode", node.name);
            assertTrue(node.readOnly);
            assertEquals(WorkflowModel.NodeKind.CALCULATION, node.nodeKind);
        } finally {
            deleteRecursive(stateRoot);
        }
    }

    @Test
    void forceAddNodeWithSpecificId() {
        WorkflowModel m = new WorkflowModel();
        m.forceAddNode("custom-id", "Custom", 10, 20);
        assertEquals(1, m.nodes().size());
        assertEquals("custom-id", m.nodes().get(0).id);
        assertEquals("Custom", m.nodes().get(0).name);
    }

    @Test
    void nodeReadOnlyDefaultsFalse() {
        WorkflowModel m = new WorkflowModel();
        var node = m.addNode(0, 0);
        assertFalse(node.readOnly);
    }

    @Test
    void scanMinecraftSourceFile() throws IOException {
        Path mcPath = Path.of("E:\\teaCraft\\Minecraft_sourceFile");
        if (Files.isDirectory(mcPath)) {
            List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(mcPath);
            assertNotNull(files, "scan should return non-null list");
        }
    }

    private static void deleteRecursive(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (IOException ignored) {} });
        }
    }
}
