package local.codenode;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class QueueServiceTest {
    @TempDir Path temp;

    @Test void submitsSelectedNodeWithVersionFourTargetAndDsl() throws Exception {
        WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);QueueService service=new QueueService(temp);var submission=service.submit(model,WorkflowModel.Mode.EXECUTABLE,QueueService.SubmitTarget.selected(node),"java","output/app");Map<String,Object> request=read(submission);
        assertEquals("4.0",request.get("schemaVersion"));assertEquals("build-node",request.get("action"));assertEquals(node.id,request.get("expression"));assertTrue(String.valueOf(request.get("snapshotHash")).startsWith("sha256:"));Map<?,?> target=(Map<?,?>)request.get("target");assertEquals("selected-node",target.get("kind"));assertEquals(List.of("node:"+node.id),target.get("codeSlotIds"));assertEquals(WorkflowModel.Status.QUEUED,node.status);
    }

    @Test void groupSubmissionOnlyIncludesReverseReachableNodes() throws Exception {
        WorkflowModel model=new WorkflowModel();var a=model.addNode(0,0);var b=model.addNode(100,0);var empty=model.addNode(100,200);var output=model.addGroupOutput(300,0,"主程序输出");model.connect(a,b);model.connect(b,b.outputs.getFirst(),output,output.inputs.getFirst());QueueService service=new QueueService(temp);var submission=service.submit(model,WorkflowModel.Mode.EXECUTABLE,QueueService.SubmitTarget.group(output),"java","output/app");Map<String,Object> request=read(submission);
        assertEquals("build-node-group",request.get("action"));assertEquals(2,((List<?>)request.get("nodes")).size());assertFalse(((List<?>)request.get("nodes")).stream().map(Map.class::cast).anyMatch(value->empty.id.equals(value.get("id"))));assertEquals(b.id+"("+a.id+")",request.get("expression"));assertEquals(List.of("node:"+b.id,"node:"+a.id),((Map<?,?>)request.get("target")).get("codeSlotIds"));
    }

    @Test void rejectsGroupSubmissionWithoutGroupOutput() throws Exception {WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);QueueService service=new QueueService(temp);assertThrows(IllegalArgumentException.class,()->service.submit(model,WorkflowModel.Mode.EXECUTABLE,node,false,"java","output"));}

    @Test void markdownModeUsesSharedDefaultFileSlotAndRendersAst() throws Exception {
        WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);node.prompt="生成程序";var output=model.addGroupOutput(200,0,"主输出");model.connect(node,node.outputs.getFirst(),output,output.inputs.getFirst());QueueService service=new QueueService(temp);var submission=service.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.group(output),"go","output/docs");Map<String,Object> request=read(submission);
        assertEquals("build-markdown-group",request.get("action"));assertEquals(List.of("file:default"),((Map<?,?>)request.get("target")).get("codeSlotIds"));assertEquals(Map.of("compile",false,"run",false),request.get("execution"));String markdown=Files.readString(submission.inboxPath().resolve("request.md"));assertTrue(markdown.contains("规范化 DSL"));assertTrue(markdown.contains("规范化 AST"));assertTrue(markdown.contains("目标语言：`go`"));
    }

    @Test void markdownModeRejectsSingleNodeSubmissionWithoutFileNode() throws Exception {
        WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);QueueService service=new QueueService(temp);assertThrows(IllegalArgumentException.class,()->service.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.selected(node),"go","output/docs"));
    }

    @Test void explicitFilesRequireMarkdownTargetOwnership() throws Exception {WorkflowModel model=new WorkflowModel();model.addFileNode(0,0,"Main.java","src/Main.java");var loose=model.addNode(100,0);QueueService service=new QueueService(temp);assertThrows(IllegalArgumentException.class,()->service.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.selected(loose),"java","output"));}

    @Test void rejectsConcurrentRequestForSameSlot() throws Exception {WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);QueueService service=new QueueService(temp);service.submit(model,WorkflowModel.Mode.EXECUTABLE,QueueService.SubmitTarget.selected(node),"java","output");assertThrows(IllegalStateException.class,()->service.submit(model,WorkflowModel.Mode.EXECUTABLE,QueueService.SubmitTarget.selected(node),"java","output"));}

    @Test void rejectsPathsOutsideProject() throws Exception {WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);assertThrows(IllegalArgumentException.class,()->new QueueService(temp).submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.selected(node),"java","../escape"));}

    private static Map<String,Object> read(QueueService.Submission submission) throws Exception{return Json.object(Files.readString(submission.inboxPath().resolve("request.json")));}
}
