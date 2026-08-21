package local.codenode;

import local.codenode.agent.components.FileSessionEventStore;
import local.codenode.agent.components.SessionEvent;
import local.codenode.agent.components.SessionEventStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionEventStoreTest {
    @Test
    void fileLogIsAppendOnlyAndForkable(@TempDir Path root) throws Exception {
        SessionEventStore store = new FileSessionEventStore();
        SessionEvent first = store.append(root, "s1", "user/message",
                Map.of("message", Map.of("role", "user", "content", "hello")));
        SessionEvent second = store.append(root, "s1", "agent/request",
                Map.of("messages", List.of(Map.of("role", "user", "content", "hello"))));

        assertEquals(1L, first.sequence());
        assertEquals(2L, second.sequence());
        assertEquals(List.of("user/message", "agent/request"),
                store.read(root, "s1").stream().map(SessionEvent::type).toList());
        assertEquals(2, store.search(root, "s1", "hello").size(),
                "search includes both the user event and the model-visible request");
        assertTrue(Files.size(root.resolve(".codenode/agent-sessions/s1.events.jsonl")) > 0);

        store.fork(root, "s1", "s2");
        assertEquals(List.of("user/message", "agent/request", "session/forked"),
                store.read(root, "s2").stream().map(SessionEvent::type).toList());
    }
}
