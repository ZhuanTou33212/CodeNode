package local.codenode;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 验证通过代码审查面板手动编辑代码后的保存/重载流程。
 * 模拟用户在新 CodeReviewPanel 中编辑代码 → 接受草稿 → 保存 → 重载 → 验证代码完好。
 */
class ManualEditWorkflowTest {

    @Test
    void testManualEditThenSaveAndReload() throws Exception {
        // 1. 创建工程，添加一个节点
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node node = model.addNode(200, 200);
        assertNotNull(node);
        WorkflowModel.CodeSlot slot = model.codeSlot("node:" + node.id);
        assertNotNull(slot);

        // 2. 模拟用户在右侧编辑面板中输入 "Hello world" 代码
        String userCode = """
                public class Hello {
                    public static void main(String[] args) {
                        System.out.println("Hello world");
                    }
                }
                """;

        // 3. 模拟「接受草稿」流程：
        //    当 codeReviewPanel.isDraftModified() == true 时，acceptDraft 先从面板读取编辑后代码，
        //    若无 draft 则创建一个新的 CodeDraft，再调用 accept
        CodeSlotService codeSlotService = new CodeSlotService();
        slot.draft = new WorkflowModel.CodeDraft(
                "manual", slot.activeRevision, userCode, "foundation.object"
        );
        codeSlotService.accept(model, slot.id);

        // 验证：活动代码已更新为用户编辑的内容
        assertEquals(userCode, slot.activeCode, "活动代码应等于用户编辑后接受的代码");
        assertEquals(1, slot.activeRevision, "活动版本应递增");

        // 4. 模拟保存到 .cnode 文件
        Path tempFile = Files.createTempFile("test-edit-workflow-", ".cnode");
        try {
            CnodeProjectCodec codec = new CnodeProjectCodec();
            codec.save(tempFile, model, new CnodeProjectCodec.Metadata(
                    "test-doc-id", "验证工程",
                    java.time.Instant.now(),
                    new CnodeProjectCodec.Settings(
                            WorkflowModel.Mode.EXECUTABLE, "java",
                            "output", "output/docs",
                            node.id, 0, 0, 1.0, node.id, java.util.List.of(node.id)
                    )
            ));

            // 5. 模拟重新打开 .cnode 文件
            CnodeProjectCodec.Loaded loaded = codec.load(tempFile);

            // 6. 验证代码被完整保留
            WorkflowModel.CodeSlot restoredSlot = loaded.model().codeSlot("node:" + node.id);
            assertNotNull(restoredSlot, "重载后代码槽应存在");
            assertEquals(userCode, restoredSlot.activeCode, "重载后活动代码应与保存前一致");
            assertEquals(1, restoredSlot.activeRevision, "重载后活动版本应一致");

            // 7. 验证无草稿（已接受后草稿被清除）
            assertNull(restoredSlot.draft, "接受后草稿应被清除");
        } finally {
            Files.deleteIfExists(tempFile);
        }
    }

    @Test
    void testEditDraftThenAcceptPreservesChanges() throws Exception {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node node = model.addNode(100, 100);
        WorkflowModel.CodeSlot slot = model.codeSlot("node:" + node.id);

        // Agent 提交了一个草稿
        String agentCode = "// Agent generated code";
        slot.draft = new WorkflowModel.CodeDraft("agent-req-1", 0L, agentCode, "foundation.object");

        // 用户在右侧修改了草稿内容（模拟 isDraftModified）
        String editedCode = "// User edited code\nSystem.out.println(\"Hello world\");";
        slot.draft.code = editedCode;

        // 接受草稿
        CodeSlotService codeSlotService = new CodeSlotService();
        codeSlotService.accept(model, slot.id);

        assertEquals(editedCode, slot.activeCode, "修改后的草稿应被接受为活动代码");
    }

    @Test
    void testRejectDraftAndRollback() throws Exception {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node node = model.addNode(100, 100);
        WorkflowModel.CodeSlot slot = model.codeSlot("node:" + node.id);

        CodeSlotService codeSlotService = new CodeSlotService();

        // 第一版代码
        String v1 = "// Version 1";
        slot.draft = new WorkflowModel.CodeDraft("r1", 0L, v1, "foundation.object");
        codeSlotService.accept(model, slot.id);
        assertEquals(v1, slot.activeCode);

        // 第二版代码（编辑后接受）
        String v2 = "// Version 2 - edited by user\nSystem.out.println(\"Hello\");";
        slot.draft = new WorkflowModel.CodeDraft("r2", 1L, v2, "foundation.object");
        codeSlotService.accept(model, slot.id);
        assertEquals(v2, slot.activeCode);

        // 回滚到第一版
        codeSlotService.rollback(model, slot.id);
        assertEquals(v1, slot.activeCode, "回滚后应恢复至第一版");
    }
}
