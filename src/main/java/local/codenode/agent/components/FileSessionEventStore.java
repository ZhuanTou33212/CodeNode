package local.codenode.agent.components;

import local.codenode.Json;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** JSONL implementation of the durable session event log. */
public final class FileSessionEventStore implements SessionEventStore {
    private final Object lock = new Object();

    @Override
    public SessionEvent append(Path projectRoot, String sessionId, String type, Map<String, Object> payload) {
        synchronized (lock) {
            try {
                Path file = file(projectRoot, sessionId);
                Files.createDirectories(file.getParent());
                long sequence = nextSequence(file);
                SessionEvent event = new SessionEvent(sequence, UUID.randomUUID().toString(), sessionId,
                        type, Instant.now(), payload);
                Files.writeString(file, Json.stringify(toMap(event)).replace("\n", "") + "\n",
                        StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                return event;
            } catch (IOException failure) {
                throw new IllegalStateException("cannot append session event", failure);
            }
        }
    }

    @Override
    public List<SessionEvent> read(Path projectRoot, String sessionId) {
        synchronized (lock) {
            Path file = file(projectRoot, sessionId);
            if (!Files.isRegularFile(file)) return List.of();
            List<SessionEvent> events = new ArrayList<>();
            try {
                for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                    if (line.isBlank()) continue;
                    try {
                        Map<String, Object> value = Json.object(line);
                        events.add(fromMap(value, sessionId));
                    } catch (RuntimeException ignored) {
                        // Ignore a torn/invalid JSONL record and preserve later events.
                    }
                }
                return List.copyOf(events);
            } catch (Exception failure) {
                throw new IllegalStateException("cannot read session event log: " + file, failure);
            }
        }
    }

    @Override
    public void delete(Path projectRoot, String sessionId) {
        synchronized (lock) {
            try { Files.deleteIfExists(file(projectRoot, sessionId)); }
            catch (IOException failure) { throw new IllegalStateException("cannot delete session event log", failure); }
        }
    }

    private static long nextSequence(Path file) throws IOException {
        if (!Files.isRegularFile(file)) return 1L;
        long max = 0L;
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            if (line.isBlank()) continue;
            try {
                Object raw = Json.object(line).get("sequence");
                if (raw instanceof Number number) max = Math.max(max, number.longValue());
            } catch (RuntimeException ignored) {
                // A partial last line is ignored; the next append receives a fresh sequence.
            }
        }
        return max + 1L;
    }

    private static Path file(Path root, String sessionId) {
        String safe = sessionId == null ? "session" : sessionId.replaceAll("[^A-Za-z0-9._-]", "_");
        return root.resolve(".codenode/agent-sessions").resolve(safe + ".events.jsonl");
    }

    private static Map<String, Object> toMap(SessionEvent event) {
        LinkedHashMap<String, Object> value = new LinkedHashMap<>();
        value.put("sequence", event.sequence());
        value.put("eventId", event.eventId());
        value.put("sessionId", event.sessionId());
        value.put("type", event.type());
        value.put("timestamp", event.timestamp().toString());
        value.put("payload", event.payload());
        return value;
    }

    private static SessionEvent fromMap(Map<String, Object> value, String fallbackSessionId) {
        long sequence = number(value.get("sequence"));
        String eventId = String.valueOf(value.getOrDefault("eventId", UUID.randomUUID().toString()));
        String sessionId = String.valueOf(value.getOrDefault("sessionId", fallbackSessionId));
        String type = String.valueOf(value.getOrDefault("type", "unknown"));
        Instant timestamp;
        try { timestamp = Instant.parse(String.valueOf(value.get("timestamp"))); }
        catch (Exception ignored) { timestamp = Instant.EPOCH; }
        Map<String, Object> payload = value.get("payload") instanceof Map<?, ?> map
                ? toStringMap(map) : Map.of();
        return new SessionEvent(sequence, eventId, sessionId, type, timestamp, payload);
    }

    private static long number(Object value) {
        return value instanceof Number number ? number.longValue() : Long.parseLong(String.valueOf(value));
    }

    private static Map<String, Object> toStringMap(Map<?, ?> source) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) result.put(String.valueOf(entry.getKey()), entry.getValue());
        return result;
    }
}
