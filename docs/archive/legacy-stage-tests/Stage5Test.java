import local.codenode.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public class Stage5Test {
    static int passed, failed;
    public static void main(String[] args) throws Exception {
        System.out.println("=== Stage5 虚拟文件相对路径自检 ===");
        testVirtualRelativePathCreation();
        testSerializationRoundTrip();
        testSubmitGroupOutputWithVirtualPath();
        testNoFileNodeSingleSubmitStillBlocked();
        System.out.printf("=== 结果: %d PASS, %d FAIL ===%n", passed, failed);
    }

    static void testVirtualRelativePathCreation() {
        System.out.println("[1] 文件节点仅相对路径可创建");
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node fileNode = model.addFileNode(0, 0, "虚拟文档", "output/agent/note.md");
        check("创建虚拟文件节点成功", fileNode != null && fileNode.nodeKind == WorkflowModel.NodeKind.FILE);
        check("relativePath 为虚拟路径（无需真实文件）", "output/agent/note.md".equals(fileNode.relativePath));
        WorkflowModel.Node empty = model.addFileNode(10, 10, "空路径节点", "");
        check("空 relativePath 文件节点可创建", empty != null && empty.relativePath.isEmpty());
        model.refreshFileSpaces();
        check("虚拟文件节点生成文件空间", model.fileSpace("space:" + fileNode.id) != null);
    }

    static void testSerializationRoundTrip() throws Exception {
        System.out.println("[2] 序列化往返");
        Path tmp = Files.createTempDirectory("stage5-serial").resolve("virtual.cnode");
        WorkflowModel model = buildModel();
        CnodeProjectCodec codec = new CnodeProjectCodec();
        CnodeProjectCodec.Settings settings = new CnodeProjectCodec.Settings(
            WorkflowModel.Mode.MARKDOWN, "java", "output/exec", "output/docs", null, 0, 0, 1.0, null);
        CnodeProjectCodec.Metadata meta = new CnodeProjectCodec.Metadata("doc-stage5", "虚拟路径工程", Instant.now(), settings);
        try {
            codec.save(tmp, model, meta);
            check("save 成功（虚拟路径通过 validateModel）", Files.isRegularFile(tmp));
            CnodeProjectCodec.Loaded loaded = codec.load(tmp);
            WorkflowModel lm = loaded.model();
            WorkflowModel.Node fileNode = lm.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.FILE).findFirst().orElse(null);
            check("往返后 FILE 节点存在", fileNode != null);
            check("往返后 relativePath 保留", fileNode != null && "output/agent/note.md".equals(fileNode.relativePath));
            check("往返后 fileSpaces 恢复", lm.fileSpace("space:" + fileNode.id) != null);
            check("往返后组输出归入空间", lm.fileSpace("space:" + fileNode.id).groupOutputNodeIds.size() == 1);
        } finally {
            try { Files.deleteIfExists(tmp); } catch (Exception ignored) {}
        }
    }

    static void testSubmitGroupOutputWithVirtualPath() throws Exception {
        System.out.println("[3] 虚拟路径节点组输出可提交");
        WorkflowModel model = buildModel();
        WorkflowModel.Node go = model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT).findFirst().orElse(null);
        check("组输出存在", go != null);
        Path root = Files.createTempDirectory("stage5-root");
        try {
            QueueService queue = new QueueService(root);
            QueueService.Submission sub = queue.submit(model, WorkflowModel.Mode.MARKDOWN,
                QueueService.SubmitTarget.group(go), "markdown", "output/docs/note.md");
            check("提交成功", sub != null && sub.requestId() != null);
            check("codeSlotIds 含 file:<nodeId>", sub != null && sub.codeSlotIds().contains("file:" + go.fileNodeId));
            check("request.json 已写入", sub != null && Files.isRegularFile(sub.inboxPath().resolve("request.json")));
        } finally {
            try { deleteRecursively(root); } catch (Exception ignored) {}
        }
    }

    static void testNoFileNodeSingleSubmitStillBlocked() {
        System.out.println("[4] 无文件节点单节点提交仍被禁止（回归）");
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node n1 = model.addNode(0, 0);
        check("无 FILE 节点时单节点提交禁止", !QueueService.isSingleNodeSubmissionAllowed(model, WorkflowModel.Mode.MARKDOWN));
        try {
            Path root = Files.createTempDirectory("stage5-block");
            try {
                QueueService queue = new QueueService(root);
                queue.submit(model, WorkflowModel.Mode.MARKDOWN, QueueService.SubmitTarget.selected(n1), "markdown", "output/docs/note.md");
                check("单节点提交应抛异常", false);
            } finally {
                try { deleteRecursively(root); } catch (Exception ignored) {}
            }
        } catch (IllegalArgumentException e) {
            check("单节点提交被拦截", true);
        } catch (Exception e) {
            check("单节点提交被拦截(异常类型: "+e.getClass().getSimpleName()+")", true);
        }
    }

    static WorkflowModel buildModel() {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node fileNode = model.addFileNode(0, 0, "虚拟文档", "output/agent/note.md");
        WorkflowModel.Node n1 = model.addNode(100, 100); n1.name = "步骤1"; n1.fileNodeId = fileNode.id;
        WorkflowModel.Node n2 = model.addNode(200, 100); n2.name = "步骤2"; n2.fileNodeId = fileNode.id;
        model.connect(n1, n1.outputs.get(0), n2, n2.inputs.get(0));
        WorkflowModel.Node go = model.addGroupOutput(400, 100, "输出");
        go.fileNodeId = fileNode.id;
        model.connect(n2, n2.outputs.get(0), go, go.inputs.get(0));
        model.refreshFileSpaces();
        return model;
    }

    static void deleteRecursively(Path path) throws Exception {
        if (path == null || !Files.exists(path)) return;
        try (var stream = Files.walk(path)) {
            stream.sorted(Comparator.reverseOrder()).forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }

    static void check(String desc, boolean cond) {
        if (cond) { System.out.println("  PASS: " + desc); passed++; }
        else { System.out.println("  FAIL: " + desc); failed++; }
    }
}
