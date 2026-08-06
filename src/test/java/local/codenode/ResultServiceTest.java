package local.codenode;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.*;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class ResultServiceTest {
    @TempDir Path temp;

    @Test void mapsCompilerDiagnosticBackToNode() throws Exception {
        WorkflowModel model=new WorkflowModel();
        var node=model.addNode(0,0);
        Path state=temp.resolve(".codenode"),resultDir=state.resolve("results/request-test");
        Files.createDirectories(resultDir);
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("requestId","request-test");result.put("status","failed");result.put("summary","compile failed");
        result.put("nodeResults",List.of(Map.of("nodeId",node.id,"status","failed")));
        result.put("diagnostics",List.of(Map.of("severity","error","nodeId",node.id,"file","Main.java","line",12,"column",7,"message","missing symbol")));
        Files.writeString(resultDir.resolve("result.json"),Json.stringify(result));
        List<String> notices=new ResultService(state).poll(model);
        assertEquals(WorkflowModel.Status.FAILED,node.status);
        assertTrue(node.diagnostic.contains("Main.java:12:7"));
        assertTrue(notices.getFirst().contains("compile failed"));
    }

    @Test void writesSuccessfulAgentCodeIntoDeclaredDraftSlot() throws Exception {
        WorkflowModel model=new WorkflowModel();
        var node=model.addNode(0,0);
        Path state=temp.resolve(".codenode");
        writeRequest(state,"completed","request-code",List.of("node:"+node.id),Map.of("node:"+node.id,0));
        writeResult(state,"request-code",List.of(Map.of("nodeId",node.id,"slotId","node:"+node.id,"status","succeeded","code","int value = 1;","classificationKey","value.scalar")));
        new ResultService(state).poll(model);
        WorkflowModel.CodeSlot slot=model.codeSlot("node:"+node.id);
        assertNotNull(slot.draft);
        assertEquals("int value = 1;",slot.draft.code);
        assertEquals("request-code",slot.lastAppliedRequestId);
        assertEquals(WorkflowModel.Status.REVIEW_READY,node.status);
        assertEquals("数值",node.category);
    }

    @Test void rejectsWholeResultThatWritesOutsideDeclaredSlots() throws Exception {
        WorkflowModel model=new WorkflowModel();
        var allowed=model.addNode(0,0);
        var outside=model.addNode(0,0);
        Path state=temp.resolve(".codenode");
        writeRequest(state,"processing","request-bad",List.of("node:"+allowed.id),Map.of());
        writeResult(state,"request-bad",List.of(
            Map.of("nodeId",allowed.id,"slotId","node:"+allowed.id,"status","succeeded","code","valid first item","classificationKey","agent.custom"),
            Map.of("nodeId",outside.id,"slotId","node:"+outside.id,"status","succeeded","code","bad","classificationKey","agent.custom")
        ));
        List<String> notices=new ResultService(state).poll(model);
        assertNull(model.codeSlot("node:"+allowed.id).draft,"整批校验失败时，前面的合法项也不能写入");
        assertNull(model.codeSlot("node:"+outside.id).draft);
        assertTrue(notices.getFirst().contains("rejected"));
        assertTrue(Files.isDirectory(state.resolve("queue/rejected/request-bad")));
    }

    @Test void replayedResultIsIdempotentAcrossServiceRestart() throws Exception {
        WorkflowModel model=new WorkflowModel();
        var node=model.addNode(0,0);
        Path state=temp.resolve(".codenode");
        writeRequest(state,"completed","request-replay",List.of("node:"+node.id),Map.of("node:"+node.id,0));
        writeResult(state,"request-replay",List.of(Map.of("nodeId",node.id,"slotId","node:"+node.id,"status","succeeded","code","stable","classificationKey","agent.custom")));
        new ResultService(state).poll(model);
        WorkflowModel.CodeDraft first=model.codeSlot("node:"+node.id).draft;
        long revision=model.revision();
        new ResultService(state).poll(model);
        assertSame(first,model.codeSlot("node:"+node.id).draft);
        assertEquals(revision,model.revision());
        assertEquals("request-replay",model.codeSlot("node:"+node.id).lastAppliedRequestId);
    }

    private static void writeRequest(Path state,String queueState,String requestId,List<String> slots,Map<String,Integer> revisions) throws Exception {
        Path requestDir=state.resolve("queue").resolve(queueState).resolve(requestId);
        Files.createDirectories(requestDir);
        Files.writeString(requestDir.resolve("request.json"),Json.stringify(Map.of("target",Map.of("codeSlotIds",slots,"baseSlotRevisions",revisions))));
    }

    private static void writeResult(Path state,String requestId,List<Map<String,Object>> nodeResults) throws Exception {
        Path resultDir=state.resolve("results").resolve(requestId);
        Files.createDirectories(resultDir);
        Files.writeString(resultDir.resolve("result.json"),Json.stringify(Map.of("requestId",requestId,"status","succeeded","summary","ready","nodeResults",nodeResults,"diagnostics",List.of())));
    }
}
