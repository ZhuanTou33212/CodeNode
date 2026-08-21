package local.codenode;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentSessionManager;
import local.codenode.agent.ChatClient;
import local.codenode.agent.ChatEvent;
import local.codenode.agent.components.HarnessComponents;
import local.codenode.agent.components.PromptAssembler;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

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

    @Test
    void reloadReplacesIdleSessionsAtomicallyAndPreservesContext() {
        AgentToolContext context = new AgentToolContext(() -> Path.of("."), () -> null,
                (level, what, detail) -> false, entry -> { });
        AgentToolRegistry registry = new AgentToolRegistry();
        AgentConfig config = new AgentConfig(Path.of("target", "agent-reload-test.properties"));
        AgentSessionManager manager = new AgentSessionManager(
                () -> new AgentChatController(config, registry, context));
        AgentSessionManager.AgentSession old = manager.activeSession();
        old.controller().restoreContext(single(old.sessionId(), "summary", "preserve me"));
        java.util.concurrent.atomic.AtomicBoolean committed = new java.util.concurrent.atomic.AtomicBoolean();

        AgentSessionManager.ReloadReport report = manager.requestHarnessReload(
                () -> new AgentChatController(config, registry, context), () -> committed.set(true));

        assertEquals(1, report.replacedImmediately());
        assertEquals(0, report.deferredUntilIdle());
        assertTrue(report.committed());
        assertTrue(committed.get());
        assertNotSame(old.controller(), manager.activeSession().controller());
        assertEquals("preserve me", manager.activeSession().controller().messageHistory().getFirst().get("content"));
        manager.close();
    }

    @Test
    void failedReloadLeavesTheActiveControllerUntouched() {
        AgentSessionManager manager = manager(2);
        AgentSessionManager.AgentSession old = manager.activeSession();
        assertThrows(IllegalStateException.class, () -> manager.requestHarnessReload(
                () -> { throw new IllegalStateException("stage failed"); }, null));
        assertSame(old.controller(), manager.activeSession().controller());
        manager.close();
    }

    @Test
    void activeSessionDefersReloadUntilItReturnsToIdle() throws Exception {
        Path root = Path.of("target", "agent-session-reload-active");
        AgentToolContext context = new AgentToolContext(() -> root, () -> null,
                (level, what, detail) -> false, entry -> { });
        AgentConfig config = new AgentConfig(root.resolve("agent.properties"));
        CountDownLatch release = new CountDownLatch(1);
        ChatClient blocking = (messages, tools, events) -> {
            release.await(5, TimeUnit.SECONDS);
            events.accept(ChatEvent.stream("done"));
            return Map.of("role", "assistant", "content", "done");
        };
        HarnessComponents oldHarness = new HarnessComponents(config, context, blocking,
                new AgentToolRegistry(), PromptAssembler.defaultAssembler(), null, List.of(), 0, List.of(), List.of());
        AgentSessionManager manager = new AgentSessionManager(() -> new AgentChatController(config, oldHarness));
        AgentChatController oldController = manager.activeSession().controller();
        oldController.sendMessage("blocking", event -> { });
        long deadline = System.currentTimeMillis() + 3000;
        while (oldController.state() == AgentProvider.SessionState.IDLE && System.currentTimeMillis() < deadline) {
            Thread.sleep(20);
        }
        assertEquals(AgentProvider.SessionState.ACTIVE_RUNNING, oldController.state());

        HarnessComponents replacementHarness = new HarnessComponents(config, context,
                (messages, tools, events) -> Map.of("role", "assistant", "content", "replacement"),
                new AgentToolRegistry(), PromptAssembler.defaultAssembler(), null, List.of(), 0, List.of(), List.of());
        AgentSessionManager.ReloadReport report = manager.requestHarnessReload(
                () -> new AgentChatController(config, replacementHarness), null);
        assertEquals(0, report.replacedImmediately());
        assertEquals(1, report.deferredUntilIdle());
        assertSame(oldController, manager.activeSession().controller());

        release.countDown();
        deadline = System.currentTimeMillis() + 5000;
        while (manager.activeSession().controller() == oldController && System.currentTimeMillis() < deadline) {
            Thread.sleep(20);
        }
        assertNotSame(oldController, manager.activeSession().controller());
        manager.close();
        oldHarness.close();
        replacementHarness.close();
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
