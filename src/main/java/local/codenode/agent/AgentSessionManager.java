package local.codenode.agent;

import local.codenode.AgentProvider;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Owns the independent chat controllers displayed as Agent tabs.
 *
 * <p>The manager deliberately does not own project-scoped services. A factory supplied by the
 * application creates every controller with the shared {@code AgentToolContext}, configuration
 * and tool registry, while the controller itself retains its private message history.</p>
 */
public final class AgentSessionManager {
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

    private final ControllerFactory controllerFactory;
    private final int maxSessions;
    private final LinkedHashMap<String, AgentSession> sessions = new LinkedHashMap<>();
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
        if (sessionId.equals(activeSessionId)) {
            List<String> remaining = new ArrayList<>(sessions.keySet());
            activeSessionId = remaining.get(Math.min(closedIndex, remaining.size() - 1));
        }
        return true;
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
        stopActiveControllers();
        sessions.clear();
        activeSessionId = null;
        nextConversationNumber = 1;

        List<AgentContext.SessionContext> persisted = context == null ? List.of() : context.allSessions();
        for (AgentContext.SessionContext item : persisted) {
            if (sessions.size() >= maxSessions) break;
            AgentChatController controller = Objects.requireNonNull(controllerFactory.create(),
                    "ControllerFactory returned null");
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
}
