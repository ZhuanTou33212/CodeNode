package local.codenode.agent.cordis;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Collections;

/** A durable-friendly event for the CodeNode Cordis runtime. */
public record CordisEvent(String type, String scope, Instant timestamp, Map<String, Object> fields) {
    public CordisEvent {
        type = requireText(type, "type");
        scope = scope == null ? "" : scope;
        timestamp = timestamp == null ? Instant.now() : timestamp;
        fields = fields == null ? Map.of() : castMap(freeze(fields));
    }

    public CordisEvent(String type, Map<String, Object> fields) {
        this(type, "", Instant.now(), fields);
    }

    public static CordisEvent of(String type, String scope, Map<String, Object> fields) {
        return new CordisEvent(type, scope, Instant.now(), fields);
    }

    /** Returns a copy with transformed structured fields for an event interceptor. */
    public CordisEvent withFields(Map<String, Object> nextFields) {
        return new CordisEvent(type, scope, timestamp, nextFields);
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
