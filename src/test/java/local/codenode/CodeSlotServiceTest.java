package local.codenode;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CodeSlotServiceTest {
    @Test void proposalRequiresReviewBeforeReplacingActiveCode(){WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);var slot=model.ensureNodeSlot(node);slot.activeCode="old";slot.activeRevision=2;CodeSlotService service=new CodeSlotService();var result=service.propose(model,slot.id,"request-1",2,"new","calculation.scalar");assertEquals(CodeSlotService.ProposalStatus.READY,result.status());assertEquals("old",slot.activeCode);assertEquals(WorkflowModel.Status.REVIEW_READY,node.status);assertEquals("数值",node.category);service.accept(model,slot.id);assertEquals("new",slot.activeCode);assertEquals(3,slot.activeRevision);assertEquals(WorkflowModel.Status.ACCEPTED,node.status);}
    @Test void staleResultBecomesConflictAndCannotOverwrite(){WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);var slot=model.ensureNodeSlot(node);slot.activeRevision=4;var result=new CodeSlotService().propose(model,slot.id,"request-old",3,"stale","agent.custom");assertEquals(CodeSlotService.ProposalStatus.CONFLICTED,result.status());assertNull(slot.draft);assertEquals("",slot.activeCode);}
    @Test void markdownFileSlotIsSharedByFileChildren(){WorkflowModel model=new WorkflowModel();var file=model.addFileNode(0,0,"Main.java","src/Main.java");var first=model.addNode(100,100);var second=model.addNode(200,100);first.fileNodeId=file.id;second.fileNodeId=file.id;var slot=model.ensureFileSlot(file);assertEquals(slot.id,model.codeSlotId(first,WorkflowModel.Mode.MARKDOWN));assertEquals(slot.id,model.codeSlotId(second,WorkflowModel.Mode.MARKDOWN));}
    @Test void canvasWithoutFileUsesDefaultSlot(){WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);assertEquals("file:default",model.codeSlotId(node,WorkflowModel.Mode.MARKDOWN));assertEquals("file:default",model.ensureDefaultFileSlot().id);}
}
