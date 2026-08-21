package local.codenode.agent.components;

import local.codenode.config.AgentConfig;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Append-only event log for a session trajectory.
 *
 * <p>This is intentionally separate from the current message snapshot store:
 * a snapshot is an optimization, while the event log is the authoritative
 * sequence that can be inspected, resumed, forked, or replayed.</p>
 */
public interface SessionEventStore extends AutoCloseable {
    SessionEvent append(Path projectRoot, String sessionId, String type, Map<String, Object> payload);

    List<SessionEvent> read(Path projectRoot, String sessionId);

    default List<SessionEvent> readFrom(Path projectRoot, String sessionId, long sequence) {
        return read(projectRoot, sessionId).stream().filter(event -> event.sequence() >= sequence).toList();
    }

    /** Replays events in durable order without exposing the concrete backend. */
    default void replay(Path projectRoot, String sessionId, Consumer<SessionEvent> consumer) {
        if (consumer == null) return;
        read(projectRoot, sessionId).forEach(consumer);
    }

    /** Case-insensitive trajectory search over event type and structured payload text. */
    default List<SessionEvent> search(Path projectRoot, String sessionId, String query) {
        if (query == null || query.isBlank()) return read(projectRoot, sessionId);
        String needle = query.toLowerCase(java.util.Locale.ROOT);
        return read(projectRoot, sessionId).stream()
                .filter(event -> event.type().toLowerCase(java.util.Locale.ROOT).contains(needle)
                        || String.valueOf(event.payload()).toLowerCase(java.util.Locale.ROOT).contains(needle))
                .toList();
    }

    /** Copies the source trajectory into a new session and records its origin. */
    default void fork(Path projectRoot, String sourceSessionId, String newSessionId) {
        for (SessionEvent event : read(projectRoot, sourceSessionId)) {
            append(projectRoot, newSessionId, event.type(), event.payload());
        }
        append(projectRoot, newSessionId, "session/forked",
                Map.of("sourceSessionId", sourceSessionId));
    }

    void delete(Path projectRoot, String sessionId);

    @Override
    default void close() { }

    @FunctionalInterface
    interface Factory {
        SessionEventStore create(AgentConfig config, local.codenode.agent.tools.AgentToolContext toolContext);
    }
}
