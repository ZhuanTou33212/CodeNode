package local.codenode;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class QueueServiceTest {
    @TempDir Path temp;
    @Test void submitsExecutableRequestAtomically() throws Exception {
        WorkflowModel model=new WorkflowModel();var a=model.addNode(0,0);var b=model.addNode(1,1);a.outputs.getFirst().name="解析结果";a.outputs.getFirst().dataType="string";b.inputs.getFirst().name="源文本";b.inputs.getFirst().dataType="string";model.connect(a,b);
        QueueService service=new QueueService(temp);var submission=service.submit(model,WorkflowModel.Mode.EXECUTABLE,b,false,"java","output/app");
        assertTrue(Files.isDirectory(submission.inboxPath()));assertFalse(Files.exists(service.stateRoot().resolve("queue/staging").resolve(submission.requestId())));
        assertEquals(submission.requestId(),service.entries().getFirst().requestId());assertEquals("inbox",service.entries().getFirst().status());
        Map<String,Object> request=Json.object(Files.readString(submission.inboxPath().resolve("request.json")));
        assertEquals("local-file-queue",request.get("transport"));assertEquals("build-program",request.get("action"));assertEquals(2,((List<?>)request.get("nodes")).size());assertEquals(b.id,request.get("expression"));
        assertEquals(List.of(a.id,"out"),((Map<?,?>)((List<?>)request.get("edges")).getFirst()).get("source"));
        Map<?,?> sourceNode=((List<?>)request.get("nodes")).stream().map(Map.class::cast).filter(n->a.id.equals(n.get("id"))).findFirst().orElseThrow();
        Map<?,?> targetNode=((List<?>)request.get("nodes")).stream().map(Map.class::cast).filter(n->b.id.equals(n.get("id"))).findFirst().orElseThrow();
        assertEquals("源文本",((Map<?,?>)((List<?>)targetNode.get("inputs")).getFirst()).get("name"));
        assertEquals("解析结果",((Map<?,?>)((List<?>)sourceNode.get("outputs")).getFirst()).get("name"));
    }
    @Test void markdownModeNeverRequestsExecution() throws Exception {
        WorkflowModel model=new WorkflowModel();var n=model.addNode(0,0);QueueService service=new QueueService(temp);
        var request=service.submit(model,WorkflowModel.Mode.MARKDOWN,n,true,"java","output/docs");Map<String,Object> json=Json.object(Files.readString(request.inboxPath().resolve("request.json")));
        assertEquals("java",json.get("language"));assertEquals("build-markdown",json.get("action"));assertEquals(Map.of("compile",false,"run",false),json.get("execution"));
    }
    @Test void markdownProjectIncludesEveryStructureNode() throws Exception {
        WorkflowModel model=new WorkflowModel();var first=model.addNode(0,0);var second=model.addNode(1,1);QueueService service=new QueueService(temp);
        var request=service.submit(model,WorkflowModel.Mode.MARKDOWN,first,false,"java","output/docs");Map<String,Object> json=Json.object(Files.readString(request.inboxPath().resolve("request.json")));
        assertEquals("project",((Map<?,?>)json.get("scope")).get("kind"));assertEquals(2,((List<?>)json.get("nodes")).size());
    }
    @Test void rejectsPathsOutsideProject() throws Exception {WorkflowModel m=new WorkflowModel();var n=m.addNode(0,0);assertThrows(IllegalArgumentException.class,()->new QueueService(temp).submit(m,WorkflowModel.Mode.MARKDOWN,n,true,"java","../escape"));}
}
