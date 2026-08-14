package local.codenode;

import local.codenode.agent.AgentInfoSnapshot;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AgentInfoSnapshotTest {
    @Test void snapshotKeepsGraphAndEnvironmentFactsButDropsSecrets() {
        AgentInfoSnapshot snapshot = new AgentInfoSnapshot(
                Map.of("version", "0.16", "graphOverview", "3 elements", "graphRoots", List.of("root"),
                        "apiKey", "do-not-export"),
                Map.of("jdk", "21", "toolsDir", "C:/tools", "password", "do-not-export"));
        assertEquals("0.16", snapshot.values().get("version"));
        assertEquals("3 elements", snapshot.values().get("graphOverview"));
        assertEquals(List.of("root"), snapshot.values().get("graphRoots"));
        assertFalse(snapshot.values().containsKey("apiKey"));
        assertFalse(snapshot.values().containsKey("password"));
    }
}
