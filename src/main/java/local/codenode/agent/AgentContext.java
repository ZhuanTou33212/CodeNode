package local.codenode.agent;

import local.codenode.Json;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Persisted Agent conversation context for a .cnode document. */
public record AgentContext(String sessionId, String summary, Instant lastUpdated, List<Map<String, Object>> messages, int maxChars, boolean truncated) {
    public static final int MAX_CHARS = 1_000_000;
    public AgentContext {
        sessionId = sessionId == null ? "" : sessionId; summary = summary == null ? "" : summary;
        lastUpdated = lastUpdated == null ? Instant.now() : lastUpdated;
        messages = messages == null ? List.of() : messages.stream().map(AgentContext::copy)
                .filter(message -> !"system".equals(String.valueOf(message.get("role"))))
                .toList();
        maxChars = maxChars <= 0 ? MAX_CHARS : Math.min(maxChars, MAX_CHARS);
    }
    public static AgentContext of(String sessionId, String summary, List<Map<String, Object>> messages) { return new AgentContext(sessionId, summary, Instant.now(), messages, MAX_CHARS, false).trimmed(); }
    public AgentContext trimmed() {
        if (jsonSize(this) <= maxChars) return this;
        List<Map<String, Object>> kept = new ArrayList<>(messages); boolean didTrim = false;
        AgentContext candidate = new AgentContext(sessionId, summary, lastUpdated, kept, maxChars, true);
        while (!kept.isEmpty() && jsonSize(candidate) > maxChars) {
            kept.remove(0); didTrim = true;
            candidate = new AgentContext(sessionId, summary, lastUpdated, kept, maxChars, true);
        }
        if (jsonSize(candidate) <= maxChars) return new AgentContext(sessionId, summary, lastUpdated, kept, maxChars, didTrim || truncated);
        int low = 0, high = summary.length();
        while (low < high) {
            int mid = (low + high + 1) >>> 1;
            AgentContext probe = new AgentContext(sessionId, summary.substring(0, mid), lastUpdated, kept, maxChars, true);
            if (jsonSize(probe) <= maxChars) low = mid; else high = mid - 1;
        }
        return new AgentContext(sessionId, summary.substring(0, low), lastUpdated, kept, maxChars, true);
    }
    public Map<String, Object> toMap() {
        LinkedHashMap<String, Object> out = new LinkedHashMap<>(); out.put("schemaVersion", 1); out.put("sessionId", sessionId); out.put("summary", summary); out.put("lastUpdated", lastUpdated.toString()); out.put("messages", messages); out.put("maxChars", maxChars); out.put("truncated", truncated); return out;
    }
    public byte[] toJsonBytes() { return Json.stringify(trimmed().toMap()).getBytes(StandardCharsets.UTF_8); }
    public static AgentContext fromMap(Map<String, Object> raw) {
        Object schema = raw.get("schemaVersion");
        if (!(schema instanceof Number number) || number.intValue() != 1) throw new IllegalArgumentException("不支持的 agent-context schemaVersion：" + schema);
        String id = String.valueOf(raw.getOrDefault("sessionId", "")); String summary = String.valueOf(raw.getOrDefault("summary", "")); Instant updated;
        try { updated = Instant.parse(String.valueOf(raw.getOrDefault("lastUpdated", Instant.now()))); } catch (Exception e) { updated = Instant.now(); }
        List<Map<String, Object>> messages = new ArrayList<>(); Object rawMessages = raw.get("messages");
        if (rawMessages instanceof List<?> list) for (Object item : list) if (item instanceof Map<?, ?> map) messages.add(copy(map));
        int max = raw.get("maxChars") instanceof Number n ? n.intValue() : MAX_CHARS; boolean truncated = Boolean.TRUE.equals(raw.get("truncated"));
        return new AgentContext(id, summary, updated, messages, max, truncated).trimmed();
    }
    private static Map<String, Object> copy(Map<?, ?> source) { LinkedHashMap<String, Object> out = new LinkedHashMap<>(); source.forEach((k, v) -> out.put(String.valueOf(k), v)); return out; }
    private static int jsonSize(AgentContext context) { return Json.stringify(context.toMap()).getBytes(StandardCharsets.UTF_8).length; }
}
