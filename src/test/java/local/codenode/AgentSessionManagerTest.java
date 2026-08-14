package local.codenode;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentSessionManager;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AgentSessionManagerTest {
    @Test
    void createsSwitchesRenamesAndClosesInStableTabOrder() {
        AgentSessionManager manager = manager(4);
        var first = manager.activeSession();
        var second = manager.createSession();
        var third = manager.createSession("Investigation");

        assertEquals(List.of(first.sessionId(), second.sessionId(), third.sessionId()),
                manager.sessions().stream().map(AgentSessionManager.AgentSession::sessionId).toList());
        assertSame(third.controller(), manager.activeSession().controller());
        assertEquals("API design", manager.rename(second.sessionId(), " API design ").title());
        assertSame(first.controller(), manager.activate(first.sessionId()).controller());

        assertTrue(manager.close(first.sessionId()));
        assertEquals(second.sessionId(), manager.activeSession().sessionId(),
                "closing the active first tab selects its right neighbour");
        assertTrue(manager.close(third.sessionId()));
        assertFalse(manager.close(second.sessionId()), "the workbench retains its last tab");
        assertFalse(manager.close("missing"));
    }

    @Test
    void controllersKeepMessagesIsolatedAndSnapshotPreservesActiveTitleAndOrder() {
        AgentSessionManager manager = manager(4);
        var first = manager.activeSession();
        first.controller().restoreContext(single(first.sessionId(), "one", "message one"));
        var second = manager.createSession("Second topic");
        second.controller().restoreContext(single(second.sessionId(), "two", "message two"));
        manager.activate(first.sessionId());

        assertEquals("message one", first.controller().messageHistory().getFirst().get("content"));
        assertEquals("message two", second.controller().messageHistory().getFirst().get("content"));

        AgentContext snapshot = manager.snapshot();
        assertEquals(2, snapshot.allSessions().size());
        assertEquals(first.sessionId(), snapshot.activeSessionId());
        assertEquals(List.of("Conversation 1", "Second topic"),
                snapshot.allSessions().stream().map(AgentContext.SessionContext::title).toList());
        assertEquals(List.of("message one", "message two"), snapshot.allSessions().stream()
                .map(tab -> String.valueOf(tab.messages().getFirst().get("content"))).toList());
    }

    @Test
    void restoreRoundTripsMultiSessionAndAcceptsLegacyContext() {
        AgentSessionManager original = manager(4);
        var first = original.activeSession();
        first.controller().restoreContext(single(first.sessionId(), "first-summary", "first"));
        var second = original.createSession("Review");
        second.controller().restoreContext(single(second.sessionId(), "second-summary", "second"));
        original.activate(second.sessionId());

        AgentSessionManager restored = manager(4);
        restored.restore(AgentContext.fromMap(original.snapshot().toMap()));
        assertEquals(2, restored.size());
        assertEquals(second.sessionId(), restored.activeSession().sessionId());
        assertEquals(List.of("Conversation 1", "Review"), restored.sessions().stream()
                .map(AgentSessionManager.AgentSession::title).toList());
        assertEquals("first", restored.sessions().getFirst().controller().messageHistory().getFirst().get("content"));
        assertEquals("second", restored.sessions().getLast().controller().messageHistory().getFirst().get("content"));

        AgentContext legacy = single("legacy-id", "legacy-summary", "legacy message");
        restored.restore(legacy);
        assertEquals(1, restored.size());
        assertEquals("legacy-id", restored.activeSession().sessionId());
        assertEquals("legacy message", restored.activeSession().controller().messageHistory().getFirst().get("content"));
    }

    @Test
    void enforcesConfiguredSessionLimitAndRejectsUnknownActivation() {
        AgentSessionManager manager = manager(2);
        manager.createSession();
        IllegalStateException full = assertThrows(IllegalStateException.class, manager::createSession);
        assertTrue(full.getMessage().contains("Maximum"));
        assertThrows(IllegalArgumentException.class, () -> manager.activate("missing"));
    }

    private static AgentSessionManager manager(int maxSessions) {
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> null,
                (level, what, detail) -> false, entry -> { });
        AgentToolRegistry registry = new AgentToolRegistry();
        AgentConfig config = new AgentConfig(Path.of("target", "agent-session-manager-test.properties"));
        return new AgentSessionManager(() -> new AgentChatController(config, registry, context), maxSessions);
    }

    private static AgentContext single(String id, String summary, String message) {
        return new AgentContext(id, summary, Instant.parse("2026-01-01T00:00:00Z"),
                List.of(Map.of("role", "user", "content", message)), AgentContext.MAX_CHARS, false);
    }
}
