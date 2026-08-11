package local.codenode;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class LargeDeleteTest {
    @Test
    void removesThousandsOfNodesInOneOperation() {
        WorkflowModel model = new WorkflowModel();
        List<WorkflowModel.Node> nodes = new ArrayList<>();
        for (int i = 0; i < 2500; i++) {
            nodes.add(model.addNode(0, i));
        }
        assertTimeoutPreemptively(Duration.ofSeconds(5), () -> model.removeNodes(nodes));
        assertEquals(0, model.nodes().size());
    }
}