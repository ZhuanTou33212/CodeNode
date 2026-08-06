package local.codenode;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.config.AgentConfig;
import local.codenode.util.BundleDataUtil;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Stage4.5 自检：4.3 资源组 v2 bundleData / 4.1 AgentConfig / 4.2 工具注册表与内置工具。 */
public class Stage45Test {

    // ---------- 4.3 BundleDataUtil ----------

    @Test
    void categorizeAssetPathClassifiesResourcePackDirs() {
        assertEquals("models", BundleDataUtil.categorizeAssetPath("assets/teaart/models/block/test.json"));
        assertEquals("textures", BundleDataUtil.categorizeAssetPath("assets/teaart/textures/block/test.png"));
        assertEquals("blockstates", BundleDataUtil.categorizeAssetPath("assets/teaart/blockstates/test.json"));
        assertEquals("lang", BundleDataUtil.categorizeAssetPath("assets/teaart/lang/en_us.json"));
        assertEquals("recipes", BundleDataUtil.categorizeAssetPath("assets/teaart/recipes/xxx.json"));
        assertEquals("loot_tables", BundleDataUtil.categorizeAssetPath("assets/teaart/loot_tables/xxx.json"));
        assertEquals("tags", BundleDataUtil.categorizeAssetPath("assets/teaart/tags/block.json"));
        assertEquals("other", BundleDataUtil.categorizeAssetPath("assets/teaart/foo.png"));
        assertEquals("other", BundleDataUtil.categorizeAssetPath("random.txt"));
        assertEquals("other", BundleDataUtil.categorizeAssetPath(null));
    }

    @Test
    void memberIdIsStableDeterministicAndShort() {
        String a = BundleDataUtil.memberId("models", "assets/x/models/a.json");
        String b = BundleDataUtil.memberId("models", "assets/x/models/a.json");
        String c = BundleDataUtil.memberId("models", "assets/x/models/b.json");
        assertEquals(a, b);
        assertEquals(16, a.length());
        assertNotEquals(a, c);
    }

    @Test
    void buildV2BundleDataStatsSumEqualsMemberCount() throws Exception {
        Path root = Files.createTempDirectory("b45-v2");
        Files.createDirectories(root.resolve("assets/m/models"));
        Files.createDirectories(root.resolve("assets/m/textures"));
        Files.writeString(root.resolve("assets/m/models/a.json"), "{}", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("assets/m/textures/b.png"), "x", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("assets/m/textures/c.png"), "y", StandardCharsets.UTF_8);
        try {
            String json = BundleDataUtil.buildV2BundleData(root, List.of(
                    "assets/m/models/a.json", "assets/m/textures/b.png", "assets/m/textures/c.png"));
            BundleDataUtil.BundleView view = BundleDataUtil.parseV2(json);
            assertEquals(2, view.schemaVersion());
            assertEquals(3, view.memberCount());
            assertEquals(3, view.members().size());
            assertEquals(view.memberCount(), view.categoryStats().values().stream().mapToInt(Integer::intValue).sum());
            assertEquals(1, view.categoryStats().get("models"));
            assertEquals(2, view.categoryStats().get("textures"));
            assertTrue(view.members().stream().allMatch(m -> !m.id().isBlank() && !m.checksum().isBlank()));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void downgradeV1DerivesCategoryAndId() {
        String v1 = "{\"files\":[{\"path\":\"assets/m/models/a.json\",\"type\":\"json\"}]}";
        BundleDataUtil.BundleView view = BundleDataUtil.downgradeV1(v1);
        assertEquals(1, view.schemaVersion());
        assertEquals(1, view.memberCount());
        assertEquals("models", view.members().getFirst().category());
        assertEquals(16, view.members().getFirst().id().length());
    }

    // ---------- 4.3 WorkflowModel ----------

    @Test
    void assetBundleDefaultsCollapsedAndExpandsV2Members() {
        WorkflowModel model = new WorkflowModel();
        String bundleData = BundleDataUtil.buildV2BundleData(null, List.of(
                "assets/m/models/a.json", "assets/m/textures/b.png"));
        WorkflowModel.Node bundle = model.addAssetBundleNode(0, 0, "资源组", bundleData, "model");
        assertTrue(bundle.bundleCollapsed);
        assertNull(bundle.memberBinding);
        WorkflowModel.Node downstream = model.addNode(200, 200);
        downstream.name = "下游";
        downstream.groupInputNodeId = bundle.id;

        List<WorkflowModel.Node> created = model.expandAssetBundle(bundle);
        assertEquals(2, created.size());
        assertEquals(2, model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET).count());
        assertTrue(created.stream().anyMatch(n -> n.id.equals(downstream.groupInputNodeId)));
        assertNull(model.byId(bundle.id));
        assertTrue(model.nodes().stream()
                .filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET)
                .allMatch(n -> n.relativePath.startsWith("assets/")));
    }

    @Test
    void bundleCollapsedAndMemberBindingCodecRoundTrip() throws Exception {
        Path file = Files.createTempDirectory("b45-codec").resolve("t.cnode");
        CnodeProjectCodec codec = new CnodeProjectCodec();
        CnodeProjectCodec.Metadata meta = new CnodeProjectCodec.Metadata("doc-45", "t", Instant.now(),
                new CnodeProjectCodec.Settings(WorkflowModel.Mode.MARKDOWN, "java", "out", "docs", null, 0, 0, 1.0, null));
        try {
            WorkflowModel model = new WorkflowModel();
            WorkflowModel.Node bundle = model.addAssetBundleNode(0, 0, "组",
                    "{\"schemaVersion\":2,\"memberCount\":0,\"categoryStats\":{},\"updatedAt\":\"\",\"members\":[]}", "model");
            bundle.bundleCollapsed = false;
            bundle.memberBinding = "[{\"memberId\":\"x\",\"sourceNodeId\":\"y\",\"slotId\":\"z\"}]";
            codec.save(file, model, meta);
            WorkflowModel loaded = codec.load(file).model();
            WorkflowModel.Node lb = loaded.nodes().stream()
                    .filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE).findFirst().orElseThrow();
            assertFalse(lb.bundleCollapsed);
            assertNull(lb.memberBinding, "memberBinding 本期不落盘");
        } finally {
            deleteRecursive(file.getParent());
        }
    }

    // ---------- 4.1 AgentConfig ----------

    @Test
    void agentConfigCreatesDefaultsAndRoundTrips() throws Exception {
        Path dir = Files.createTempDirectory("b45-config");
        try {
            Path file = dir.resolve("agent.properties");
            AgentConfig config = new AgentConfig(file);
            config.setApiBase("https://api.example.com/v1");
            config.setApiKey("secret-key");
            config.setModel("test-model");
            config.setModels(List.of("deepseek-v4-flash", "deepseek-v4-pro"));
            config.setDefaultProjectPath("E:\\teaCraft");
            config.save();
            assertTrue(Files.isRegularFile(file));
            AgentConfig loaded = new AgentConfig(file);
            loaded.reload();
            assertEquals("https://api.example.com/v1", loaded.apiBase());
            assertEquals("secret-key", loaded.apiKey());
            assertEquals("test-model", loaded.model());
            assertEquals("E:\\teaCraft", loaded.defaultProjectPath());
            assertEquals(List.of("deepseek-v4-flash", "deepseek-v4-pro"), loaded.models());
            assertTrue(loaded.isConfigured());
        } finally {
            deleteRecursive(dir);
        }
    }

    // ---------- 4.2 工具 ----------

    @Test
    void readFileReadsInsideProjectAndRejectsTraversal() throws Exception {
        Path root = Files.createTempDirectory("b45-tool");
        Files.writeString(root.resolve("a.txt"), "hello\nworld\n", StandardCharsets.UTF_8);
        try {
            AgentToolContext context = new AgentToolContext(() -> root, () -> null, msg -> false, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            AgentToolResult ok = registry.execute("read_file", Map.of("path", "a.txt"), context);
            assertTrue(ok.ok());
            assertTrue(ok.text().contains("hello"));
            AgentToolResult bad = registry.execute("read_file", Map.of("path", "../outside.txt"), context);
            assertFalse(bad.ok());
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void writeFileRequiresConfirmationAndAudits() throws Exception {
        Path root = Files.createTempDirectory("b45-write");
        List<String> audit = new java.util.ArrayList<>();
        try {
            AgentToolContext context = new AgentToolContext(() -> root, () -> null, msg -> false, audit::add);
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            AgentToolResult result = registry.execute("write_file",
                    Map.of("path", "x.txt", "content", "data"), context);
            assertFalse(result.ok());
            assertFalse(Files.exists(root.resolve("x.txt")));
            assertTrue(audit.isEmpty());
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void codeReviewDetectsPasswordAndTodoDeterministically() {
        String code = "String password = \"hunter2\";\n// TODO fix later\nint x = 1;\n";
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> null, msg -> false, entry -> {});
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("code_review", Map.of("code", code), context);
        assertTrue(result.ok());
        assertTrue(result.text().contains("硬编码密码"));
        assertTrue(result.text().contains("TODO"));
        AgentToolResult again = registry.execute("code_review", Map.of("code", code), context);
        assertEquals(result.data().get("total"), again.data().get("total"), "确定性输出");
    }

    @Test
    void executeShellEnforcesWhitelist() {
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> null, msg -> true, entry -> {});
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("execute_shell", Map.of("command", "rm -rf /"), context);
        assertFalse(result.ok());
        assertTrue(result.text().contains("白名单"));
    }

    @Test
    void getWorkbenchModelReportsNodeCount() {
        WorkflowModel model = new WorkflowModel();
        model.addNode(0, 0);
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> model, msg -> false, entry -> {});
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("get_workbench_model", Map.of(), context);
        assertTrue(result.ok());
        assertEquals(1, ((List<?>) result.data().get("nodes")).size());
    }

    @Test
    void scanProjectBuildsGraphStats() throws Exception {
        Path root = Files.createTempDirectory("b45-scan");
        Files.createDirectories(root.resolve("src/main/java/com/demo"));
        Files.createDirectories(root.resolve("assets/demo/models"));
        Files.createDirectories(root.resolve("assets/demo/textures"));
        Files.writeString(root.resolve("src/main/java/com/demo/Main.java"),
                "package com.demo;\nimport java.util.List;\npublic class Main {}\n", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("assets/demo/models/block.json"), "{}", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("assets/demo/textures/stone.png"), "x", StandardCharsets.UTF_8);
        try {
            AgentToolContext context = new AgentToolContext(() -> root, () -> null, msg -> false, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            AgentToolResult result = registry.execute("scan_project", Map.of(), context);
            assertTrue(result.ok());
            assertTrue(((Number) result.data().get("sourceFiles")).intValue() >= 1);
            assertTrue(((Number) result.data().get("nodes")).intValue() >= 1);
            // 资产聚为资源组而非逐个普通节点
            assertTrue(((Number) result.data().get("assetBundles")).intValue() >= 1,
                    "资产应聚为 ASSET_BUNDLE 资源组");
            assertTrue(((Number) result.data().get("groups")).intValue() >= 1,
                    "源码应按 package 归入 GROUP");
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void scanProjectApplyToWorkbenchWritesStructuredGraph() throws Exception {
        Path root = Files.createTempDirectory("b45-apply");
        Files.createDirectories(root.resolve("src/main/java/com/demo"));
        Files.createDirectories(root.resolve("assets/demo/models"));
        Files.writeString(root.resolve("src/main/java/com/demo/Main.java"),
                "package com.demo;\npublic class Main {}\n", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("assets/demo/models/block.json"), "{}", StandardCharsets.UTF_8);
        final WorkflowModel[] applied = {null};
        try {
            AgentToolContext context = new AgentToolContext(() -> root, () -> null, msg -> false, entry -> {},
                    generated -> applied[0] = generated);
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            AgentToolResult result = registry.execute("scan_project",
                    Map.of("applyToWorkbench", true), context);
            assertTrue(result.ok());
            assertTrue(Boolean.TRUE.equals(result.data().get("appliedToWorkbench")));
            assertNotNull(applied[0], "应把生成图写入工作台");
            assertTrue(applied[0].nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE),
                    "写入的图应包含资源组节点");
            assertTrue(applied[0].nodes().stream().noneMatch(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET),
                    "资产不应成为逐个 ASSET 节点");
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void createNodesCreatesAndConnectsOnWorkbench() {
        WorkflowModel model = new WorkflowModel();
        final WorkflowModel[] mutated = {model};
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> model, msg -> false, entry -> {},
                null, mutator -> { mutator.mutate(mutated[0]); });
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult result = registry.execute("create_nodes",
                Map.of("count", 3, "name", "步骤", "category", "基础", "prompt", "p", "connect", true), context);
        assertTrue(result.ok());
        assertEquals(3, ((List<?>) result.data().get("nodeIds")).size());
        assertEquals(3, model.nodes().size());
        assertEquals("步骤1", model.nodes().get(0).name);
        assertEquals("步骤3", model.nodes().get(2).name);
        assertEquals(2, model.edges().size(), "connect=true 应串联成链");
    }

    @Test
    void workbenchEditRenamesMovesAndDeletes() {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node a = model.addNode(0, 0);
        WorkflowModel.Node b = model.addNode(100, 100);
        AgentToolContext context = contextWithModel(model);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);

        assertTrue(registry.execute("workbench_edit",
                Map.of("action", "rename", "nodeId", a.id, "name", "新名"), context).ok());
        assertEquals("新名", a.name);
        assertTrue(registry.execute("workbench_edit",
                Map.of("action", "move", "nodeId", b.id, "x", 300, "y", 200), context).ok());
        assertEquals(300, b.x);
        assertTrue(registry.execute("workbench_edit",
                Map.of("action", "set_status", "nodeId", a.id, "value", "failed"), context).ok());
        assertEquals(WorkflowModel.Status.FAILED, a.status);
        assertTrue(registry.execute("workbench_edit",
                Map.of("action", "delete", "nodeId", b.id), context).ok());
        assertNull(model.byId(b.id));
    }

    @Test
    void workbenchConnectAndDisconnect() {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node a = model.addNode(0, 0);
        WorkflowModel.Node b = model.addNode(100, 100);
        AgentToolContext context = contextWithModel(model);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        assertTrue(registry.execute("workbench_connect",
                Map.of("action", "connect", "sourceId", a.id, "targetId", b.id), context).ok());
        assertEquals(1, model.edges().size());
        assertTrue(registry.execute("workbench_connect",
                Map.of("action", "disconnect", "sourceId", a.id, "targetId", b.id), context).ok());
        assertEquals(0, model.edges().size());
    }

    @Test
    void workbenchStructureGroupAndUngroup() {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node a = model.addNode(0, 0);
        WorkflowModel.Node b = model.addNode(50, 50);
        AgentToolContext context = contextWithModel(model);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        assertTrue(registry.execute("workbench_structure",
                Map.of("action", "group", "nodeIds", List.of(a.id, b.id), "name", "组A"), context).ok());
        WorkflowModel.Node group = model.nodes().stream()
                .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP).findFirst().orElseThrow();
        assertEquals(group.id, a.parentScopeId);
        assertEquals(group.id, b.parentScopeId);
        assertTrue(registry.execute("workbench_structure",
                Map.of("action", "ungroup", "nodeId", group.id), context).ok());
        assertNull(model.byId(group.id));
        assertTrue(a.parentScopeId.isBlank());
    }

    @Test
    void workbenchStructureAddRemovePort() {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node a = model.addNode(0, 0);
        AgentToolContext context = contextWithModel(model);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        int before = a.outputs.size();
        assertTrue(registry.execute("workbench_structure",
                Map.of("action", "add_port", "nodeId", a.id, "direction", "output"), context).ok());
        assertEquals(before + 1, a.outputs.size());
        String addedId = a.outputs.getLast().id;
        assertTrue(registry.execute("workbench_structure",
                Map.of("action", "remove_port", "nodeId", a.id, "direction", "output", "portId", addedId), context).ok());
        assertEquals(before, a.outputs.size());
    }

    @Test
    void editFileReplacesTextWithBackup() throws Exception {
        Path root = Files.createTempDirectory("b45-edit");
        Files.writeString(root.resolve("demo.txt"), "hello world\nsecond line\n", StandardCharsets.UTF_8);
        try {
            AgentToolContext context = new AgentToolContext(() -> root, () -> null, msg -> true, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            AgentToolResult r = registry.execute("edit_file",
                    Map.of("path", "demo.txt", "oldText", "world", "newText", "codex"), context);
            assertTrue(r.ok());
            assertTrue(Files.readString(root.resolve("demo.txt")).contains("hello codex"));
            assertTrue(Files.isRegularFile(root.resolve("demo.txt.bak")), "应自动备份 .bak");
            AgentToolResult missing = registry.execute("edit_file",
                    Map.of("path", "demo.txt", "oldText", "不存在的文本"), context);
            assertFalse(missing.ok());
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void findFilesAndSearchFilesAndListDirectory() throws Exception {
        Path root = Files.createTempDirectory("b45-find");
        Files.createDirectories(root.resolve("src/main/java"));
        Files.createDirectories(root.resolve("assets"));
        Files.writeString(root.resolve("src/main/java/Main.java"), "package demo;\nint value = 42;\n", StandardCharsets.UTF_8);
        Files.writeString(root.resolve("assets/a.json"), "{\"k\":1}", StandardCharsets.UTF_8);
        try {
            AgentToolContext context = new AgentToolContext(() -> root, () -> null, msg -> false, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
            assertTrue(registry.execute("find_files", Map.of("pattern", "**/*.java"), context).ok());
            AgentToolResult found = registry.execute("find_files", Map.of("pattern", "**/*.java"), context);
            assertTrue(found.text().contains("Main.java"));
            AgentToolResult search = registry.execute("search_files", Map.of("pattern", "value = 42"), context);
            assertTrue(search.ok());
            assertTrue(search.text().contains("Main.java:2"));
            AgentToolResult list = registry.execute("list_directory", Map.of(), context);
            assertTrue(list.ok());
            assertTrue(list.text().contains("src/") || list.text().contains("assets/"));
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void askUserReturnsAnswerFromHandler() {
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> null, msg -> false, entry -> {});
        context.setQuestionHandler((question, options) -> "my-answer");
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);
        AgentToolResult r = registry.execute("ask_user", Map.of("question", "选哪个？", "options", List.of("A", "B")), context);
        assertTrue(r.ok());
        assertEquals("my-answer", r.data().get("answer"));
    }

    private static AgentToolContext contextWithModel(WorkflowModel model) {
        return new AgentToolContext(() -> Path.of("."), () -> model, msg -> false, entry -> {},
                null, mutator -> mutator.mutate(model), () -> {}, () -> {}, () -> {});
    }

    // ---------- 4.1 AppServerMessages ----------

    @Test
    void appServerMessagesMapping() {
        assertEquals("start_thread_request", AppServerMessages.toSnakeCase("startThreadRequest"));
        assertEquals("startThreadRequest", AppServerMessages.toCamelCase("start_thread_request"));
        assertEquals(AppServerMessages.MessageType.START_THREAD_REQUEST,
                AppServerMessages.MessageType.fromCamelCase("startThreadRequest"));
        assertEquals(AppServerMessages.MessageType.START_THREAD_REQUEST,
                AppServerMessages.MessageType.fromWire("thread/start"));
        assertEquals(AppServerMessages.MessageType.CANCEL_REQUEST,
                AppServerMessages.MessageType.fromWire("turn/interrupt"));
    }

    private static void deleteRecursive(Path dir) throws Exception {
        if (dir == null || !Files.exists(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }
}
