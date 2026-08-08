package local.codenode;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.util.BundleDataUtil;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Stage4.5 全量扫描 + Agent 能力测试：
 * DirectoryGraphBuilder / HierarchyLayout / 资源组解组 / decodeArchitecture /
 * LocalCompiler / RuntimeTraceService / 新工具。
 */
public class Stage45FullScanTest {

    @Test
    void assetLeafDirBecomesGroupWithAssetNodes() throws Exception {
        Path root = Files.createTempDirectory("fs-bundle");
        Files.createDirectories(root.resolve("assets/minecraft/textures/block"));
        Files.writeString(root.resolve("assets/minecraft/textures/block/stone.png"), "x", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("assets/minecraft/textures/block/dirt.png"), "y", StandardCharsets.UTF_8);
        try {
            WorkflowModel model = new WorkflowModel();
            DirectoryGraphBuilder.build(model, root);
            // 资产叶子目录现在也成普通组，不再生成 ASSET_BUNDLE
            assertEquals(0, model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE).count());
            WorkflowModel.Node group = model.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP && "block".equals(n.name)).findFirst().orElseThrow();
            assertEquals("folder", group.role);
            assertTrue(group.outputs.stream().anyMatch(p -> p.id.equals("grp_out_value")));
            WorkflowModel.Node gi = model.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT && group.id.equals(n.parentScopeId))
                    .findFirst().orElseThrow();
            WorkflowModel.Node go = model.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT && group.id.equals(n.parentScopeId))
                    .findFirst().orElseThrow();
            assertNotNull(gi);
            assertNotNull(go);
            // 资产文件 → ASSET 节点，接入组输出
            List<WorkflowModel.Node> assets = model.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET && group.id.equals(n.parentScopeId)).toList();
            assertEquals(2, assets.size());
            for (WorkflowModel.Node asset : assets) {
                assertTrue(model.edges().stream()
                        .anyMatch(e -> e.source().equals(asset.id) && e.target().equals(go.id)));
            }
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void directoryBecomesGroupWithContentsWiredToGroupOutput() throws Exception {
        Path root = Files.createTempDirectory("fs-group");
        Files.createDirectories(root.resolve("src/main"));
        Files.writeString(root.resolve("src/main/Main.java"),
                "package main;\npublic class Main {}\n", StandardCharsets.UTF_8);
        try {
            WorkflowModel model = new WorkflowModel();
            DirectoryGraphBuilder.build(model, root);
            WorkflowModel.Node group = model.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP && "folder".equals(n.role))
                    .filter(n -> "src/main".equals(n.relativePath))
                    .findFirst().orElseThrow();
            assertTrue(group.outputs.stream().anyMatch(p -> p.id.equals("grp_out_value")));
            WorkflowModel.Node go = model.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT && group.id.equals(n.parentScopeId))
                    .findFirst().orElseThrow();
            WorkflowModel.Node fileNode = model.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.FILE).findFirst().orElseThrow();
            assertEquals("src/main/Main.java", fileNode.relativePath);
            assertTrue(model.edges().stream()
                            .anyMatch(e -> e.source().equals(fileNode.id) && e.target().equals(go.id)));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void cacheDirsAreIgnored() throws Exception {
        Path root = Files.createTempDirectory("fs-ignore");
        Files.createDirectories(root.resolve("target"));
        Files.createDirectories(root.resolve(".git"));
        Files.createDirectories(root.resolve("src"));
        Files.writeString(root.resolve("target/out.class"), "x", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("src/Real.java"), "class Real {}", StandardCharsets.UTF_8);
        try {
            WorkflowModel model = new WorkflowModel();
            DirectoryGraphBuilder.build(model, root);
            assertTrue(model.nodes().stream().noneMatch(n -> n.name.equals("target") || n.name.equals(".git")));
            assertTrue(model.nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.FILE
                    && n.name.equals("Real.java")));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void ungroupAssetBundleKeepsIdAndWiresMembersToGroupOutput() {
        WorkflowModel model = new WorkflowModel();
        String bundleData = BundleDataUtil.buildV2BundleData(null, List.of(
                "assets/m/models/a.json", "assets/m/textures/b.png"));
        WorkflowModel.Node bundle = model.addAssetBundleNode(0, 0, "资源组", bundleData, "model");
        String id = bundle.id;
        WorkflowModel.Node downstream = model.addNode(200, 200);
        downstream.groupInputNodeId = bundle.id;

        WorkflowModel.Node group = model.ungroupAssetBundleToGroup(bundle);
        assertNotNull(group);
        assertEquals(id, group.id);
        assertEquals(WorkflowModel.NodeKind.GROUP, group.nodeKind);
        assertEquals("folder", group.role);
        assertTrue(group.outputs.stream().anyMatch(p -> p.id.equals("grp_out_value")));
        WorkflowModel.Node go = model.nodes().stream()
                .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT && id.equals(n.parentScopeId))
                .findFirst().orElseThrow();
        List<WorkflowModel.Node> assets = model.nodes().stream()
                .filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET && id.equals(n.parentScopeId)).toList();
        assertEquals(2, assets.size());
        for (WorkflowModel.Node asset : assets) {
            assertTrue(model.edges().stream()
                            .anyMatch(e -> e.source().equals(asset.id) && e.target().equals(go.id)));
        }
        assertEquals(downstream.groupInputNodeId, id);
    }

    @Test
    void workbenchStructureUngroupBundleAction() {
        WorkflowModel model = new WorkflowModel();
        String bundleData = BundleDataUtil.buildV2BundleData(null, List.of("a.png"));
        WorkflowModel.Node bundle = model.addAssetBundleNode(0, 0, "组", bundleData, "image");
        String id = bundle.id;
        AgentToolContext context = contextWithModel(model);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("workbench_structure",
                Map.of("action", "ungroup_bundle", "nodeId", id), context);
        assertTrue(result.ok());
        WorkflowModel.Node now = model.byId(id);
        assertNotNull(now);
        assertEquals(WorkflowModel.NodeKind.GROUP, now.nodeKind);
    }

    @Test
    void decodeArchitectureProducesMarkdownAndAst() throws Exception {
        Path root = Files.createTempDirectory("fs-arch");
        Files.createDirectories(root.resolve("assets/m/textures"));
        Files.writeString(root.resolve("assets/m/textures/stone.png"), "x", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("Main.java"), "class Main {}", StandardCharsets.UTF_8);
        try {
            WorkflowModel model = new WorkflowModel();
            DirectoryGraphBuilder.build(model, root);
            WorkflowDslService.Architecture architecture = new WorkflowDslService().decodeArchitecture(model);
            assertTrue(architecture.markdown().contains("项目分析架构"));
            assertEquals("project-architecture", architecture.ast().get("type"));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void localCompilerCompilesAndRunsHelloWorld() {
        LocalCompiler.RunResult result = LocalCompiler.compileAndRun(
                Map.of("Hello.java", "public class Hello { public static void main(String[] a) { System.out.println(\"hi45\"); } }"),
                "Hello", List.of(), 30);
        assertTrue(result.ok());
        assertEquals(0, result.exitCode());
        assertTrue(result.output().contains("hi45"));
    }

    @Test
    void localCompilerReportsCompileErrors() {
        LocalCompiler.RunResult result = LocalCompiler.compileAndRun(
                Map.of("Bad.java", "public class Bad { int x = ; }"), "Bad", List.of(), 30);
        assertFalse(result.ok());
        assertFalse(result.compiled());
    }

    @Test
    void runtimeTraceCollectsScopeProgramsAndAssets() throws Exception {
        Path root = Files.createTempDirectory("fs-trace");
        try {
            WorkflowModel model = new WorkflowModel();
            WorkflowModel.Node file = model.addFileNode(0, 0, "App.java", "App.java");
            WorkflowModel.CodeSlot slot = model.ensureFileSlot(file);
            slot.activeCode = "public class App { public static void main(String[] a) { System.out.println(\"trace\"); } }";
            slot.language = "java";
            Map<String, Object> trace = RuntimeTraceService.trace(model, root, file.id, List.of(), 30);
            assertEquals(1, ((Number) trace.get("programs")).intValue());
            assertEquals("App", trace.get("mainClass"));
            assertTrue(String.valueOf(trace.get("output")).contains("trace"));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void compileRunToolWithExplicitSources() {
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> new WorkflowModel(), msg -> false, entry -> {});
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("compile_run", Map.of(
                "sourceFiles", Map.of("Main.java",
                        "public class Main { public static void main(String[] a) { System.out.println(\"tool-run\"); } }")), context);
        assertTrue(result.ok());
        assertEquals(0, ((Number) result.data().get("exitCode")).intValue());
    }

    @Test
    void runtimeTraceToolReturnsPrograms() throws Exception {
        Path root = Files.createTempDirectory("fs-trace-tool");
        try {
            WorkflowModel model = new WorkflowModel();
            WorkflowModel.Node file = model.addFileNode(0, 0, "App.java", "App.java");
            WorkflowModel.CodeSlot slot = model.ensureFileSlot(file);
            slot.activeCode = "public class App { public static void main(String[] a) { System.out.println(\"rt\"); } }";
            AgentToolContext context = new AgentToolContext(() -> root, () -> model, msg -> false, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            AgentToolResult result = registry.execute("runtime_trace",
                    Map.of("targetId", file.id), context);
            assertTrue(result.ok(), "runtime_trace 失败：" + result.text());
            assertTrue(result.text().contains("App.java"));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void writeAnalysisMdWritesMdNode() {
        WorkflowModel model = new WorkflowModel();
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> model, msg -> false, entry -> {},
                null, mutator -> mutator.mutate(model));
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("write_analysis_md",
                Map.of("content", "# 分析\n- 内容", "name", "项目分析"), context);
        assertTrue(result.ok());
        WorkflowModel.Node mdNode = model.byId(String.valueOf(result.data().get("nodeId")));
        assertNotNull(mdNode);
        assertEquals(WorkflowModel.NodeKind.FILE, mdNode.nodeKind);
        WorkflowModel.CodeSlot mdSlot = model.codeSlot("file:" + mdNode.id);
        assertNotNull(mdSlot);
        assertEquals("markdown", mdSlot.language);
    }

    @Test
    void uiControlCallsUiActionWhenWired() {
        List<String> actions = new java.util.ArrayList<>();
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> new WorkflowModel(), msg -> false, entry -> {},
                null, null, () -> {}, () -> {}, () -> {},
                (action, arguments) -> actions.add(action + ":" + arguments.get("zoom")));
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("ui_control",
                Map.of("action", "zoom", "zoom", 1.5), context);
        assertTrue(result.ok());
        assertEquals("zoom:1.5", actions.getFirst());
    }

    @Test
    void createNodesPresetsFileAssetBundleGroup() {
        WorkflowModel model = new WorkflowModel();
        AgentToolContext context = contextWithModel(model);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        assertTrue(registry.execute("create_nodes",
                Map.of("nodeKind", "file", "name", "Read.java", "relativePath", "src/Read.java"), context).ok());
        assertTrue(registry.execute("create_nodes",
                Map.of("nodeKind", "asset", "name", "stone.png", "relativePath", "textures/stone.png", "assetType", "texture"), context).ok());
        assertTrue(registry.execute("create_nodes",
                Map.of("nodeKind", "bundle", "name", "纹理", "assetType", "texture"), context).ok());
        assertTrue(registry.execute("create_nodes",
                Map.of("nodeKind", "group", "name", "包组"), context).ok());
        assertTrue(model.nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.FILE
                && "src/Read.java".equals(n.relativePath)));
        assertTrue(model.nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET
                && "texture".equals(n.assetType)));
        assertTrue(model.nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE));
        assertTrue(model.nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP));
    }

    private static AgentToolContext contextWithModel(WorkflowModel model) {
        return new AgentToolContext(() -> Path.of("."), () -> model, msg -> false, entry -> {},
                null, mutator -> mutator.mutate(model), () -> {}, () -> {}, () -> {});
    }

    private static void deleteRecursive(Path dir) throws Exception {
        if (dir == null || !Files.exists(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }
}
