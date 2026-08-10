package local.codenode;

import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.PermissionMemory;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class Stage49Test {
    @Test
    void contextIsBoundedAndRoundTrips() throws Exception {
        AgentContext context = AgentContext.of("session", "summary", List.of(Map.of("role", "user", "content", "hello")));
        assertEquals("session", CnodeProjectCodec.decodeAgentContext(CnodeProjectCodec.encodeAgentContext(context)).sessionId());
        AgentInfoSnapshot snapshot = new AgentInfoSnapshot(Map.of("api_key", "secret", "projectRoot", "E:\\private\\demo"), Map.of("jdk", "21"));
        assertFalse(snapshot.toText().contains("secret"));
        assertFalse(snapshot.toText().contains("E:\\private"));
    }

    @Test
    void permissionMemoryIsSessionScoped() {
        PermissionMemory memory = new PermissionMemory();
        memory.remember("tool|arg", true);
        assertTrue(memory.get("tool|arg"));
        memory.clear();
        assertNull(memory.get("tool|arg"));
    }
}
