package local.codenode.agent.components;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Collections;

/** One append-only fact in an agent session trajectory. */
public record SessionEvent(long sequence, String eventId, String sessionId, String type,
                           Instant timestamp, Map<String, Object> payload) {
    public SessionEvent {
        if (sequence < 1) throw new IllegalArgumentException("sequence must be positive");
        eventId = requireText(eventId, "eventId");
        sessionId = requireText(sessionId, "sessionId");
        type = requireText(type, "type");
        timestamp = timestamp == null ? Instant.now() : timestamp;
        payload = payload == null ? Map.of() : castMap(freeze(payload));
    }

    private static String requireText(String value, String name) {
        String normalized = Objects.requireNonNull(value, name).trim();
        if (normalized.isEmpty()) throw new IllegalArgumentException(name + " must not be blank");
        return normalized;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) { return (Map<String, Object>) value; }

    private static Object freeze(Object value) {
        if (value instanceof Map<?, ?> map) {
            LinkedHashMap<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) copy.put(String.valueOf(entry.getKey()), freeze(entry.getValue()));
            return Collections.unmodifiableMap(copy);
        }
        if (value instanceof Collection<?> collection) {
            List<Object> copy = new ArrayList<>();
            for (Object item : collection) copy.add(freeze(item));
            return Collections.unmodifiableList(copy);
        }
        return value;
    }
}
