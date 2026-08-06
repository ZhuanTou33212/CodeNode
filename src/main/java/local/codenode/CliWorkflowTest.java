package local.codenode;

import java.io.IOException;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public final class CliWorkflowTest {
    public static void main(String[] args) throws Exception {
        Path projectRoot = Path.of(System.getProperty("user.home")).resolve("Desktop").resolve("codenode-test-project");
        Files.createDirectories(projectRoot);

        WorkflowModel model = new WorkflowModel();

        WorkflowModel.Node node1 = model.addNode(200, 200);
        node1.name = "新建文件夹在桌面";
        node1.prompt = "在当前用户的桌面上创建一个名为 'CodeNodeExport' 的新文件夹。使用 PowerShell 的 New-Item 命令，目标路径为 $env:USERPROFILE\\Desktop\\CodeNodeExport。";
        node1.category = "基础";
        node1.classificationKey = "foundation.object";
        node1.codeBearing = true;
        node1.inputs.clear();
        node1.outputs.clear();
        node1.outputs.add(new WorkflowModel.Port("folderPath", "文件夹路径", "string", false));

        WorkflowModel.Node node2 = model.addNode(500, 200);
        node2.name = "新建Word文档并写入HelloWorld";
        node2.prompt = "在 CodeNodeExport 文件夹中创建一个 Word 文档 'HelloWorld.docx'，并在文档中写入 'Hello world!'。使用 PowerShell 的 COM 对象 Word.Application 来创建文档，或者如果 Word 不可用则创建 .md 备用文件。";
        node2.category = "基础";
        node2.classificationKey = "foundation.object";
        node2.codeBearing = true;
        node2.inputs.clear();
        node2.inputs.add(new WorkflowModel.Port("folderIn", "文件夹路径输入", "string", true));
        node2.outputs.clear();
        node2.outputs.add(new WorkflowModel.Port("docPath", "文档路径", "string", false));

        model.connect(node1, node1.outputs.get(0), node2, node2.inputs.get(0));

        Path projectFile = projectRoot.resolve("HelloWorld.cnode");
        CnodeProjectCodec codec = new CnodeProjectCodec();
        CnodeProjectCodec.Settings settings = new CnodeProjectCodec.Settings(
                WorkflowModel.Mode.MARKDOWN, "powershell",
                "output", "output/docs",
                node2.id, 0, 0, 1.0, node2.id
        );
        CnodeProjectCodec.Metadata metadata = new CnodeProjectCodec.Metadata(
                UUID.randomUUID().toString(), "HelloWorld", Instant.now(), settings
        );
        codec.save(projectFile, model, metadata);
        System.out.println("[OK] Project saved: " + projectFile);

        Path codenodeDir = projectRoot.resolve(".codenode");
        QueueService queue = new QueueService(projectRoot);

        QueueService.Submission submission = queue.submit(model, WorkflowModel.Mode.MARKDOWN,
                QueueService.SubmitTarget.selected(node2), "powershell", "output/docs");
        System.out.println("[OK] Queue submission created: " + submission.requestId());
        System.out.println("    Inbox: " + submission.inboxPath());
        System.out.println("    Code slots: " + submission.codeSlotIds());

        Path requestMd = submission.inboxPath().resolve("request.md");
        System.out.println("\n=== request.md content ===");
        System.out.println(Files.readString(requestMd));

        System.out.println("\n=== Done ===");
        System.out.println("Open in CodeNode Desktop:");
        System.out.println("  java -jar codenode-desktop.jar " + projectFile);
    }
}
