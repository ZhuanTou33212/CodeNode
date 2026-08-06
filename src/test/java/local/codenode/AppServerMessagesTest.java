package local.codenode;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AppServerMessagesTest {
    @Test void buildsOfficialHandshakeWithoutJsonRpcEnvelope() {
        Map<String,Object> initialize = AppServerMessages.initialize(1);
        assertEquals("initialize", initialize.get("method"));
        assertFalse(initialize.containsKey("jsonrpc"));
        assertEquals("initialized", AppServerMessages.initialized().get("method"));
        Map<String,Object> thread = AppServerMessages.startThread(2, Path.of("project"));
        assertEquals("workspace-write", ((Map<?,?>) thread.get("params")).get("sandbox"));
        assertEquals("never", ((Map<?,?>) thread.get("params")).get("approvalPolicy"));
    }

    @Test void constrainsTurnToLocalResultContract() {
        Path root = Path.of("project").toAbsolutePath().normalize();
        Map<String,Object> message = AppServerMessages.startTurn(3, "thread-1", root, root.resolve(".codenode/queue/inbox/request-1"));
        Map<?,?> params = (Map<?,?>) message.get("params");
        Map<?,?> sandbox = (Map<?,?>) params.get("sandboxPolicy");
        assertEquals(false, sandbox.get("networkAccess"));
        assertEquals(List.of(root.toString()), sandbox.get("writableRoots"));
        String prompt = String.valueOf(((Map<?,?>)((List<?>)params.get("input")).getFirst()).get("text"));
        assertTrue(prompt.contains("result.json"));
        assertTrue(prompt.contains("不要修改 .cnode"));
    }
}
