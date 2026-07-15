package local.codenode;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ResultServiceTest {
    @TempDir Path temp;

    @Test void mapsCompilerDiagnosticBackToNode() throws Exception {
        WorkflowModel model=new WorkflowModel();var node=model.addNode(0,0);
        Path state=temp.resolve(".codenode"), resultDir=state.resolve("results/request-test");Files.createDirectories(resultDir);
        Map<String,Object> result=new LinkedHashMap<>();result.put("requestId","request-test");result.put("status","failed");result.put("summary","compile failed");
        result.put("nodeResults",List.of(Map.of("nodeId",node.id,"status","failed")));
        result.put("diagnostics",List.of(Map.of("severity","error","nodeId",node.id,"file","Main.java","line",12,"column",7,"message","missing symbol")));
        Files.writeString(resultDir.resolve("result.json"),Json.stringify(result));
        List<String> notices=new ResultService(state).poll(model);
        assertEquals(WorkflowModel.Status.FAILED,node.status);assertTrue(node.diagnostic.contains("Main.java:12:7"));assertTrue(notices.getFirst().contains("compile failed"));
    }
}
