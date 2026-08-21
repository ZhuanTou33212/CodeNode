package local.codenode.agent;

import local.codenode.AgentProvider;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Owns the independent chat controllers displayed as Agent tabs.
 *
 * <p>The manager deliberately does not own project-scoped services. A factory supplied by the
 * application creates every controller with the shared {@code AgentToolContext}, configuration
 * and tool registry, while the controller itself retains its private message history.</p>
 */
public final class AgentSessionManager implements AutoCloseable {
    public static final int DEFAULT_MAX_SESSIONS = 16;

    @FunctionalInterface
    public interface ControllerFactory {
        AgentChatController create();
    }

    /** Stable session identity and the controller that owns this tab's conversation. */
    public record AgentSession(String sessionId, String title, AgentChatController controller) {
        public AgentSession {
            sessionId = requireText(sessionId, "sessionId");
            title = normalizedTitle(title, "Conversation");
            controller = Objects.requireNonNull(controller, "controller");
        }
    }

    private ControllerFactory controllerFactory;
    private final int maxSessions;
    private final LinkedHashMap<String, AgentSession> sessions = new LinkedHashMap<>();
    private ControllerFactory pendingControllerFactory;
    private final Set<String> pendingSessionIds = new LinkedHashSet<>();
    private Runnable pendingCommit;
    private String activeSessionId;
    private int nextConversationNumber = 1;

    /** Creates a manager with one initial session. */
    public AgentSessionManager(ControllerFactory controllerFactory) {
        this(controllerFactory, DEFAULT_MAX_SESSIONS);
    }

    /** Creates a manager with one initial session and an explicit concurrency/UI tab bound. */
    public AgentSessionManager(ControllerFactory controllerFactory, int maxSessions) {
        this.controllerFactory = Objects.requireNonNull(controllerFactory, "controllerFactory");
        if (maxSessions < 1) throw new IllegalArgumentException("maxSessions must be at least 1");
        this.maxSessions = maxSessions;
        createSession();
    }

    /** Creates and activates a tab named {@code Conversation N}. */
    public synchronized AgentSession createSession() {
        return createSessionWithTitle(nextDefaultTitle());
    }

    /** Creates and activates a tab with a caller-provided title. */
    public synchronized AgentSession createSession(String title) {
        String actualTitle = title == null || title.isBlank() ? nextDefaultTitle() : title.trim();
        return createSessionWithTitle(actualTitle);
    }

    private AgentSession createSessionWithTitle(String title) {
        ensureCapacity();
        AgentChatController controller = Objects.requireNonNull(controllerFactory.create(),
                "ControllerFactory returned null");
        bindController(controller);
        String id = requireText(controller.sessionId(), "controller.sessionId");
        if (sessions.containsKey(id)) {
            throw new IllegalStateException("ControllerFactory returned duplicate sessionId: " + id);
        }
        AgentSession session = new AgentSession(id, title, controller);
        sessions.put(id, session);
        activeSessionId = id;
        updateNextNumber(session.title());
        return session;
    }

    /** Returns sessions in their stable tab order. */
    public synchronized List<AgentSession> sessions() {
        return List.copyOf(sessions.values());
    }

    public synchronized int size() {
        return sessions.size();
    }

    public int maxSessions() {
        return maxSessions;
    }

    public synchronized AgentSession activeSession() {
        AgentSession active = sessions.get(activeSessionId);
        if (active == null) throw new IllegalStateException("No active Agent session");
        return active;
    }

    public synchronized Optional<AgentSession> findSession(String sessionId) {
        return Optional.ofNullable(sessions.get(sessionId));
    }

    /** Switches the active tab. */
    public synchronized AgentSession activate(String sessionId) {
        AgentSession session = sessions.get(requireText(sessionId, "sessionId"));
        if (session == null) throw new IllegalArgumentException("Unknown Agent session: " + sessionId);
        activeSessionId = session.sessionId();
        return session;
    }

    /** Renames a tab without replacing its controller or changing tab order. */
    public synchronized AgentSession rename(String sessionId, String title) {
        AgentSession current = sessions.get(requireText(sessionId, "sessionId"));
        if (current == null) throw new IllegalArgumentException("Unknown Agent session: " + sessionId);
        AgentSession renamed = new AgentSession(current.sessionId(), normalizedTitle(title, current.title()),
                current.controller());
        sessions.put(sessionId, renamed);
        updateNextNumber(renamed.title());
        return renamed;
    }

    /**
     * Closes a tab. The last tab is retained so the Agent workbench always has an active chat.
     * Closing the active tab selects its right neighbour, or the preceding tab at the end.
     */
    public synchronized boolean close(String sessionId) {
        AgentSession target = sessions.get(sessionId);
        if (target == null) return false;
        if (sessions.size() == 1) return false;

        List<String> order = new ArrayList<>(sessions.keySet());
        int closedIndex = order.indexOf(sessionId);
        if (target.controller().state() != AgentProvider.SessionState.IDLE) {
            target.controller().requestStop();
        }
        sessions.remove(sessionId);
        pendingSessionIds.remove(sessionId);
        if (sessionId.equals(activeSessionId)) {
            List<String> remaining = new ArrayList<>(sessions.keySet());
            activeSessionId = remaining.get(Math.min(closedIndex, remaining.size() - 1));
        }
        target.controller().close();
        finishPendingIfReady();
        return true;
    }

    /** Stages and atomically applies a new Harness controller factory. */
    public synchronized ReloadReport requestHarnessReload(ControllerFactory replacementFactory,
                                                           Runnable onCommitted) {
        Objects.requireNonNull(replacementFactory, "replacementFactory");
        if (pendingControllerFactory != null) throw new IllegalStateException("harness reload already pending");
        List<PreparedReplacement> prepared = new ArrayList<>();
        try {
            for (AgentSession session : sessions.values()) {
                if (session.controller().state() == AgentProvider.SessionState.IDLE) {
                    prepared.add(prepareReplacement(session, replacementFactory));
                }
            }
        } catch (RuntimeException failure) {
            for (PreparedReplacement item : prepared) item.controller().close();
            throw failure;
        }
        this.controllerFactory = replacementFactory;
        this.pendingControllerFactory = replacementFactory;
        this.pendingCommit = onCommitted;
        this.pendingSessionIds.clear();
        for (AgentSession session : sessions.values()) {
            if (session.controller().state() != AgentProvider.SessionState.IDLE) {
                pendingSessionIds.add(session.sessionId());
            }
        }
        int replaced = 0;
        for (PreparedReplacement item : prepared) {
            commitReplacement(item);
            replaced++;
        }
        boolean committed = finishPendingIfReady();
        return new ReloadReport(replaced, pendingSessionIds.size(), committed);
    }

    /** Applies replacements for sessions that have since returned to IDLE. */
    public synchronized ReloadReport applyPendingHarnessReload() {
        if (pendingControllerFactory == null) return new ReloadReport(0, 0, true);
        List<PreparedReplacement> prepared = new ArrayList<>();
        try {
            for (String id : List.copyOf(pendingSessionIds)) {
                AgentSession session = sessions.get(id);
                if (session != null && session.controller().state() == AgentProvider.SessionState.IDLE) {
                    prepared.add(prepareReplacement(session, pendingControllerFactory));
                }
            }
        } catch (RuntimeException failure) {
            for (PreparedReplacement item : prepared) item.controller().close();
            return new ReloadReport(0, pendingSessionIds.size(), false);
        }
        for (PreparedReplacement item : prepared) {
            pendingSessionIds.remove(item.session().sessionId());
            commitReplacement(item);
        }
        boolean committed = finishPendingIfReady();
        return new ReloadReport(prepared.size(), pendingSessionIds.size(), committed);
    }

    private PreparedReplacement prepareReplacement(AgentSession session, ControllerFactory factory) {
        AgentChatController replacement = Objects.requireNonNull(factory.create(),
                "replacement factory returned null");
        try {
            replacement.restoreContext(session.controller().snapshotContext());
            bindController(replacement);
            return new PreparedReplacement(session, replacement);
        } catch (RuntimeException failure) {
            replacement.close();
            throw failure;
        }
    }

    private void commitReplacement(PreparedReplacement prepared) {
        AgentSession old = prepared.session();
        sessions.put(old.sessionId(), new AgentSession(old.sessionId(), old.title(), prepared.controller()));
        old.controller().close();
    }

    private void bindController(AgentChatController controller) {
        controller.setIdleHook(this::applyPendingHarnessReload);
    }

    private boolean finishPendingIfReady() {
        if (pendingControllerFactory == null || !pendingSessionIds.isEmpty()) return false;
        Runnable callback = pendingCommit;
        pendingControllerFactory = null;
        pendingCommit = null;
        if (callback != null) {
            try { callback.run(); } catch (RuntimeException ignored) { }
        }
        return true;
    }

    /** Closes every session-owned resource without closing the shared harness. */
    @Override
    public synchronized void close() {
        for (AgentSession session : sessions.values()) session.controller().close();
        sessions.clear();
        pendingSessionIds.clear();
        pendingControllerFactory = null;
        pendingCommit = null;
        activeSessionId = null;
    }

    /** Captures every tab in the document-level, backward-compatible AgentContext schema. */
    public synchronized AgentContext snapshot() {
        List<AgentContext.SessionContext> contexts = sessions.values().stream().map(session -> {
            AgentContext context = session.controller().snapshotContext();
            return new AgentContext.SessionContext(context.sessionId(), session.title(), context.summary(),
                    context.lastUpdated(), context.messages());
        }).toList();
        return AgentContext.multi(activeSessionId, contexts);
    }

    /**
     * Replaces all live tabs from persisted context. A legacy v1 context naturally restores as
     * one tab through {@link AgentContext#allSessions()}.
     */
    public synchronized void restore(AgentContext context) {
        pendingSessionIds.clear();
        pendingControllerFactory = null;
        pendingCommit = null;
        stopActiveControllers();
        sessions.clear();
        activeSessionId = null;
        nextConversationNumber = 1;

        List<AgentContext.SessionContext> persisted = context == null ? List.of() : context.allSessions();
        for (AgentContext.SessionContext item : persisted) {
            if (sessions.size() >= maxSessions) break;
            AgentChatController controller = Objects.requireNonNull(controllerFactory.create(),
                    "ControllerFactory returned null");
            bindController(controller);
            AgentContext single = new AgentContext(item.sessionId(), item.summary(), item.lastUpdated(),
                    item.messages(), AgentContext.MAX_CHARS, false);
            controller.restoreContext(single);
            String id = requireText(controller.sessionId(), "controller.sessionId");
            if (sessions.containsKey(id)) continue;
            AgentSession session = new AgentSession(id, item.title(), controller);
            sessions.put(id, session);
            updateNextNumber(session.title());
        }
        if (sessions.isEmpty()) {
            createSession();
            return;
        }
        String requestedActive = context == null ? "" : context.activeSessionId();
        activeSessionId = sessions.containsKey(requestedActive)
                ? requestedActive : sessions.keySet().iterator().next();
    }

    private void stopActiveControllers() {
        for (AgentSession session : sessions.values()) {
            if (session.controller().state() != AgentProvider.SessionState.IDLE) {
                session.controller().requestStop();
            }
            session.controller().close();
        }
    }

    private void ensureCapacity() {
        if (sessions.size() >= maxSessions) {
            throw new IllegalStateException("Maximum Agent session count reached: " + maxSessions);
        }
    }

    private String nextDefaultTitle() {
        return "Conversation " + nextConversationNumber++;
    }

    private void updateNextNumber(String title) {
        if (!title.startsWith("Conversation ")) return;
        try {
            nextConversationNumber = Math.max(nextConversationNumber,
                    Integer.parseInt(title.substring("Conversation ".length()).trim()) + 1);
        } catch (NumberFormatException ignored) {
            // Custom title that happens to share the prefix.
        }
    }

    private static String normalizedTitle(String title, String fallback) {
        String value = title == null ? "" : title.trim();
        return value.isBlank() ? fallback : value;
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return value;
    }

    public record ReloadReport(int replacedImmediately, int deferredUntilIdle, boolean committed) { }

    private record PreparedReplacement(AgentSession session, AgentChatController controller) { }
}
