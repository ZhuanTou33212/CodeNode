package local.codenode.agent.components;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** In-memory append-only session log for deterministic tests and minimal mode. */
public final class MemorySessionEventStore implements SessionEventStore {
    private final Map<String, List<SessionEvent>> logs = new LinkedHashMap<>();

    @Override
    public synchronized SessionEvent append(Path projectRoot, String sessionId, String type, Map<String, Object> payload) {
        String key = key(projectRoot, sessionId);
        List<SessionEvent> log = logs.computeIfAbsent(key, ignored -> new ArrayList<>());
        SessionEvent event = new SessionEvent(log.size() + 1L, UUID.randomUUID().toString(), sessionId,
                type, java.time.Instant.now(), payload);
        log.add(event);
        return event;
    }

    @Override
    public synchronized List<SessionEvent> read(Path projectRoot, String sessionId) {
        return List.copyOf(logs.getOrDefault(key(projectRoot, sessionId), List.of()));
    }

    @Override
    public synchronized void delete(Path projectRoot, String sessionId) {
        logs.remove(key(projectRoot, sessionId));
    }

    private static String key(Path root, String sessionId) { return String.valueOf(root) + "\n" + sessionId; }
}
