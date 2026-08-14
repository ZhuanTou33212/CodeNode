package local.codenode.agent;

import local.codenode.Json;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Persisted Agent conversation context for one document, including optional chat tabs. */
public record AgentContext(String sessionId, String summary, Instant lastUpdated,
                           List<Map<String, Object>> messages, int maxChars, boolean truncated,
                           List<SessionContext> sessions, String activeSessionId) {
    public static final int MAX_CHARS = 1_000_000;

    /** Backward-compatible single-session constructor. */
    public AgentContext(String sessionId, String summary, Instant lastUpdated,
                        List<Map<String, Object>> messages, int maxChars, boolean truncated) {
        this(sessionId, summary, lastUpdated, messages, maxChars, truncated, List.of(), sessionId);
    }

    public AgentContext {
        sessionId = clean(sessionId);
        summary = clean(summary);
        lastUpdated = lastUpdated == null ? Instant.now() : lastUpdated;
        messages = cleanMessages(messages);
        maxChars = maxChars <= 0 ? MAX_CHARS : Math.min(maxChars, MAX_CHARS);
        sessions = sessions == null ? List.of() : sessions.stream()
                .filter(java.util.Objects::nonNull).map(SessionContext::copy).toList();
        activeSessionId = clean(activeSessionId);
        if (activeSessionId.isBlank()) activeSessionId = sessionId;
    }

    public static AgentContext of(String sessionId, String summary, List<Map<String, Object>> messages) {
        return new AgentContext(sessionId, summary, Instant.now(), messages, MAX_CHARS, false).trimmed();
    }

    /** Build a multi-tab context while preserving the legacy active-session fields. */
    public static AgentContext multi(String activeSessionId, List<SessionContext> sessions) {
        List<SessionContext> actual = sessions == null ? List.of() : sessions.stream()
                .filter(java.util.Objects::nonNull).map(SessionContext::copy).toList();
        SessionContext active = actual.stream().filter(s -> s.sessionId().equals(activeSessionId)).findFirst()
                .orElseGet(() -> actual.isEmpty()
                        ? new SessionContext(activeSessionId, "Conversation 1", "", Instant.now(), List.of())
                        : actual.getFirst());
        return new AgentContext(active.sessionId(), active.summary(), active.lastUpdated(), active.messages(),
                MAX_CHARS, false, actual, active.sessionId()).trimmed();
    }

    /** Returns every persisted tab; legacy schema v1 is exposed as one tab. */
    public List<SessionContext> allSessions() {
        if (!sessions.isEmpty()) return sessions;
        if (sessionId.isBlank() && messages.isEmpty() && summary.isBlank()) return List.of();
        return List.of(new SessionContext(sessionId, "Conversation 1", summary, lastUpdated, messages));
    }

    public AgentContext trimmed() {
        AgentContext candidate = this;
        if (jsonSize(candidate) <= maxChars) return candidate;

        List<Map<String, Object>> legacy = new ArrayList<>(messages);
        List<MutableSession> tabs = sessions.stream().map(MutableSession::new).toList();
        boolean didTrim = truncated;
        while (jsonSize(candidate) > maxChars) {
            MutableSession target = tabs.stream().filter(s -> !s.messages.isEmpty())
                    .max(java.util.Comparator.comparingInt(s -> s.messages.size())).orElse(null);
            if (target != null) {
                target.messages.removeFirst();
                didTrim = true;
            } else if (!legacy.isEmpty()) {
                legacy.removeFirst();
                didTrim = true;
            } else break;
            List<SessionContext> snapshot = tabs.stream().map(MutableSession::snapshot).toList();
            SessionContext active = snapshot.stream().filter(s -> s.sessionId().equals(activeSessionId)).findFirst().orElse(null);
            List<Map<String, Object>> activeMessages = active == null ? legacy : active.messages();
            String activeSummary = active == null ? summary : active.summary();
            candidate = new AgentContext(sessionId, activeSummary, lastUpdated, activeMessages, maxChars, true,
                    snapshot, activeSessionId);
        }
        if (jsonSize(candidate) <= maxChars) return candidate;

        // If session metadata itself is oversized, trim each summary before the legacy summary.
        List<SessionContext> reducedTabs = new ArrayList<>(candidate.sessions());
        for (int i = 0; i < reducedTabs.size() && jsonSize(candidate) > maxChars; i++) {
            SessionContext tab = reducedTabs.get(i);
            String text = tab.summary();
            int lowTab = 0, highTab = text.length();
            while (lowTab < highTab) {
                int mid = (lowTab + highTab + 1) >>> 1;
                ArrayList<SessionContext> probeTabs = new ArrayList<>(reducedTabs);
                probeTabs.set(i, new SessionContext(tab.sessionId(), tab.title(), text.substring(0, mid), tab.lastUpdated(), tab.messages()));
                AgentContext probe = new AgentContext(candidate.sessionId(), candidate.summary(), candidate.lastUpdated(),
                        candidate.messages(), maxChars, true, probeTabs, candidate.activeSessionId());
                if (jsonSize(probe) <= maxChars) lowTab = mid; else highTab = mid - 1;
            }
            reducedTabs.set(i, new SessionContext(tab.sessionId(), tab.title(), text.substring(0, lowTab), tab.lastUpdated(), tab.messages()));
            candidate = new AgentContext(candidate.sessionId(), candidate.summary(), candidate.lastUpdated(),
                    candidate.messages(), maxChars, true, reducedTabs, candidate.activeSessionId());
        }
        if (jsonSize(candidate) <= maxChars) return candidate;

        // Titles are presentation metadata; bound pathological imported values as a last resort.
        for (int i = 0; i < reducedTabs.size() && jsonSize(candidate) > maxChars; i++) {
            SessionContext tab = reducedTabs.get(i);
            if (tab.title().length() <= 128) continue;
            reducedTabs.set(i, new SessionContext(tab.sessionId(), tab.title().substring(0, 128),
                    tab.summary(), tab.lastUpdated(), tab.messages()));
            candidate = new AgentContext(candidate.sessionId(), candidate.summary(), candidate.lastUpdated(),
                    candidate.messages(), maxChars, true, reducedTabs, candidate.activeSessionId());
        }
        if (jsonSize(candidate) <= maxChars) return candidate;

        String shortened = candidate.summary();
        int low = 0, high = shortened.length();
        while (low < high) {
            int mid = (low + high + 1) >>> 1;
            AgentContext probe = new AgentContext(candidate.sessionId(), shortened.substring(0, mid),
                    candidate.lastUpdated(), candidate.messages(), maxChars, true,
                    candidate.sessions(), candidate.activeSessionId());
            if (jsonSize(probe) <= maxChars) low = mid; else high = mid - 1;
        }
        return new AgentContext(candidate.sessionId(), shortened.substring(0, low), candidate.lastUpdated(),
                candidate.messages(), maxChars, true, candidate.sessions(), candidate.activeSessionId());
    }

    public Map<String, Object> toMap() {
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("schemaVersion", sessions.isEmpty() ? 1 : 2);
        out.put("sessionId", sessionId);
        out.put("summary", summary);
        out.put("lastUpdated", lastUpdated.toString());
        out.put("messages", messages);
        out.put("maxChars", maxChars);
        out.put("truncated", truncated);
        if (!sessions.isEmpty()) {
            out.put("activeSessionId", activeSessionId);
            out.put("sessions", sessions.stream().map(SessionContext::toMap).toList());
        }
        return out;
    }

    public byte[] toJsonBytes() {
        return Json.stringify(trimmed().toMap()).getBytes(StandardCharsets.UTF_8);
    }

    public static AgentContext fromMap(Map<String, Object> raw) {
        Object schema = raw.get("schemaVersion");
        if (!(schema instanceof Number number) || number.intValue() < 1 || number.intValue() > 2) {
            throw new IllegalArgumentException("Unsupported agent-context schemaVersion: " + schema);
        }
        String id = clean(raw.get("sessionId"));
        String summary = clean(raw.get("summary"));
        Instant updated = parseInstant(raw.get("lastUpdated"));
        List<Map<String, Object>> messages = parseMessages(raw.get("messages"));
        int max = raw.get("maxChars") instanceof Number n ? n.intValue() : MAX_CHARS;
        boolean truncated = Boolean.TRUE.equals(raw.get("truncated"));
        List<SessionContext> sessions = new ArrayList<>();
        if (number.intValue() == 2 && raw.get("sessions") instanceof List<?> list) {
            for (Object item : list) if (item instanceof Map<?, ?> map) sessions.add(SessionContext.fromMap(map));
        }
        String active = clean(raw.getOrDefault("activeSessionId", id));
        String requestedActive = active;
        if (!sessions.isEmpty() && sessions.stream().noneMatch(s -> s.sessionId().equals(requestedActive))) {
            active = sessions.getFirst().sessionId();
        }
        if (!sessions.isEmpty()) {
            String selectedId = active;
            SessionContext selected = sessions.stream().filter(s -> s.sessionId().equals(selectedId)).findFirst().orElse(sessions.getFirst());
            id = selected.sessionId(); summary = selected.summary(); updated = selected.lastUpdated(); messages = selected.messages();
        }
        return new AgentContext(id, summary, updated, messages, max, truncated, sessions, active).trimmed();
    }

    public record SessionContext(String sessionId, String title, String summary, Instant lastUpdated,
                                 List<Map<String, Object>> messages) {
        public SessionContext {
            sessionId = clean(sessionId);
            title = clean(title);
            if (title.isBlank()) title = "Conversation";
            summary = clean(summary);
            lastUpdated = lastUpdated == null ? Instant.now() : lastUpdated;
            messages = cleanMessages(messages);
        }
        private SessionContext copy() { return new SessionContext(sessionId, title, summary, lastUpdated, messages); }
        private Map<String, Object> toMap() {
            return Map.of("sessionId", sessionId, "title", title, "summary", summary,
                    "lastUpdated", lastUpdated.toString(), "messages", messages);
        }
        private static SessionContext fromMap(Map<?, ?> raw) {
            return new SessionContext(clean(raw.get("sessionId")), clean(raw.get("title")),
                    clean(raw.get("summary")), parseInstant(raw.get("lastUpdated")), parseMessages(raw.get("messages")));
        }
    }

    private static final class MutableSession {
        final String id, title, summary;
        final Instant updated;
        final ArrayList<Map<String, Object>> messages;
        MutableSession(SessionContext source) {
            id = source.sessionId(); title = source.title(); summary = source.summary(); updated = source.lastUpdated();
            messages = new ArrayList<>(source.messages());
        }
        SessionContext snapshot() { return new SessionContext(id, title, summary, updated, messages); }
    }

    private static List<Map<String, Object>> cleanMessages(List<Map<String, Object>> source) {
        if (source == null) return List.of();
        return source.stream().map(AgentContext::copy)
                .filter(message -> !"system".equals(String.valueOf(message.get("role")))).toList();
    }
    private static List<Map<String, Object>> parseMessages(Object raw) {
        List<Map<String, Object>> result = new ArrayList<>();
        if (raw instanceof List<?> list) for (Object item : list) if (item instanceof Map<?, ?> map) result.add(copy(map));
        return result;
    }
    private static Map<String, Object> copy(Map<?, ?> source) {
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        source.forEach((k, v) -> out.put(String.valueOf(k), v));
        return out;
    }
    private static String clean(Object value) { return value == null ? "" : String.valueOf(value); }
    private static Instant parseInstant(Object value) {
        try { return Instant.parse(clean(value)); } catch (Exception ignored) { return Instant.now(); }
    }
    private static int jsonSize(AgentContext context) {
        return Json.stringify(context.toMap()).getBytes(StandardCharsets.UTF_8).length;
    }
}
