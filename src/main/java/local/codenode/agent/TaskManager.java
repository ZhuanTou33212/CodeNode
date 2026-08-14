package local.codenode.agent;

import local.codenode.Json;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Thread-safe task list shared by agent sessions.
 *
 * <p>A bound manager persists every successful mutation to
 * {@code <projectRoot>/.codenode/tasks/<documentId>.json}. An unbound manager
 * is useful for a document that has not been saved yet and keeps tasks in
 * memory until {@link #bind(Path, String)} is called.</p>
 */
public final class TaskManager {
    public static final String FORMAT = "codenode-tasks";
    public static final int SCHEMA_VERSION = 1;

    private static final Pattern DOCUMENT_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final Pattern GENERATED_ID = Pattern.compile("t(\\d+)");
    private static final Set<String> STATUSES = Set.of("pending", "in_progress", "blocked", "done", "cancelled");
    private static final Map<String, Set<String>> TRANSITIONS = Map.of(
            "pending", Set.of("pending", "in_progress", "blocked", "done", "cancelled"),
            "in_progress", Set.of("pending", "in_progress", "blocked", "done", "cancelled"),
            "blocked", Set.of("pending", "in_progress", "blocked", "done", "cancelled"),
            "done", Set.of("pending", "done"),
            "cancelled", Set.of("pending", "cancelled"));

    /** Immutable task value exposed to callers and JSON serialization. */
    public record Task(String id, String desc, String status, String note) {
        public Task {
            id = required(id, "id");
            desc = required(desc, "desc");
            status = normalizeStatus(status);
            note = note == null ? "" : note;
        }

        public Map<String, Object> toMap() {
            LinkedHashMap<String, Object> value = new LinkedHashMap<>();
            value.put("id", id);
            value.put("desc", desc);
            value.put("status", status);
            value.put("note", note);
            return value;
        }
    }

    private final LinkedHashMap<String, Task> tasks = new LinkedHashMap<>();
    private Path projectRoot;
    private String documentId;
    private long nextId = 1;

    public TaskManager() {
    }

    public TaskManager(Path projectRoot, String documentId) throws IOException {
        bind(projectRoot, documentId);
    }

    /**
     * Binds this manager to a document and loads its existing task file.
     * Binding a non-empty manager is rejected so tasks cannot be silently lost.
     */
    public synchronized void bind(Path root, String id) throws IOException {
        Objects.requireNonNull(root, "projectRoot");
        validateDocumentId(id);
        Path normalized = root.toAbsolutePath().normalize();
        if (projectRoot != null && projectRoot.equals(normalized) && documentId.equals(id)) return;
        boolean hasInMemoryTasks = !tasks.isEmpty();
        Path target = normalized.resolve(".codenode").resolve("tasks").resolve(id + ".json");
        if (hasInMemoryTasks && Files.exists(target)) {
            throw new IllegalStateException("Cannot merge in-memory tasks with an existing task file");
        }
        projectRoot = normalized;
        documentId = id;
        if (hasInMemoryTasks) persist(); else loadFromDisk();
    }

    public synchronized boolean isBound() {
        return projectRoot != null;
    }

    public synchronized String documentId() {
        return documentId;
    }

    public synchronized Path persistencePath() {
        return isBound() ? projectRoot.resolve(".codenode").resolve("tasks").resolve(documentId + ".json") : null;
    }

    public synchronized List<Task> list() {
        return List.copyOf(tasks.values());
    }

    public synchronized Task get(String id) {
        return tasks.get(required(id, "id"));
    }

    public synchronized Task add(String desc) throws IOException {
        return add(desc, "pending", "");
    }

    public synchronized Task add(String desc, String note) throws IOException {
        return add(desc, "pending", note);
    }

    public synchronized Task add(String desc, String status, String note) throws IOException {
        String taskId;
        do taskId = "t" + nextId++; while (tasks.containsKey(taskId));
        Task task = new Task(taskId, desc, status == null || status.isBlank() ? "pending" : status, note);
        tasks.put(task.id(), task);
        try {
            persist();
        } catch (IOException | RuntimeException failure) {
            tasks.remove(task.id());
            nextId--;
            throw failure;
        }
        return task;
    }

    /** Updates supplied fields; null fields retain their old value. */
    public synchronized Task update(String id, String desc, String status, String note) throws IOException {
        String taskId = required(id, "id");
        Task old = tasks.get(taskId);
        if (old == null) throw new IllegalArgumentException("Unknown task id: " + taskId);
        String newStatus = status == null ? old.status() : normalizeStatus(status);
        validateTransition(old.status(), newStatus);
        Task updated = new Task(taskId,
                desc == null ? old.desc() : desc,
                newStatus,
                note == null ? old.note() : note);
        tasks.put(taskId, updated);
        try {
            persist();
        } catch (IOException | RuntimeException failure) {
            tasks.put(taskId, old);
            throw failure;
        }
        return updated;
    }

    public synchronized Task update(String id, String status, String note) throws IOException {
        return update(id, null, status, note);
    }

    public synchronized int clear() throws IOException {
        if (tasks.isEmpty()) return 0;
        LinkedHashMap<String, Task> old = new LinkedHashMap<>(tasks);
        tasks.clear();
        try {
            persist();
        } catch (IOException | RuntimeException failure) {
            tasks.putAll(old);
            throw failure;
        }
        return old.size();
    }

    public synchronized Map<String, Object> toMap() {
        LinkedHashMap<String, Object> value = new LinkedHashMap<>();
        value.put("format", FORMAT);
        value.put("schemaVersion", SCHEMA_VERSION);
        if (documentId != null) value.put("documentId", documentId);
        value.put("tasks", tasks.values().stream().map(Task::toMap).toList());
        return value;
    }

    public synchronized String toJson() {
        return Json.stringify(toMap());
    }

    public static TaskManager fromJson(String json) {
        TaskManager manager = new TaskManager();
        manager.replaceFromMap(Json.object(Objects.requireNonNull(json, "json")), null);
        return manager;
    }

    public static boolean validStatus(String status) {
        if (status == null) return false;
        return STATUSES.contains(status.trim().toLowerCase(Locale.ROOT));
    }

    private void loadFromDisk() throws IOException {
        Path path = persistencePath();
        if (!Files.exists(path)) return;
        final Map<String, Object> parsed;
        try {
            parsed = Json.object(Files.readString(path, StandardCharsets.UTF_8));
        } catch (RuntimeException malformed) {
            throw new IOException("Invalid task JSON: " + path, malformed);
        }
        replaceFromMap(parsed, documentId);
    }

    private void replaceFromMap(Map<String, Object> raw, String expectedDocumentId) {
        if (!FORMAT.equals(raw.get("format"))) {
            throw new IllegalArgumentException("Unsupported task format: " + raw.get("format"));
        }
        Object version = raw.get("schemaVersion");
        if (!(version instanceof Number number) || number.intValue() != SCHEMA_VERSION) {
            throw new IllegalArgumentException("Unsupported task schemaVersion: " + version);
        }
        String loadedDocumentId = optionalString(raw.get("documentId"));
        if (expectedDocumentId != null && !expectedDocumentId.equals(loadedDocumentId)) {
            throw new IllegalArgumentException("Task documentId mismatch: " + loadedDocumentId);
        }
        Object items = raw.get("tasks");
        if (!(items instanceof List<?> list)) throw new IllegalArgumentException("tasks must be an array");
        LinkedHashMap<String, Task> loaded = new LinkedHashMap<>();
        long candidateNextId = 1;
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> map)) throw new IllegalArgumentException("task must be an object");
            Task task = new Task(string(map, "id"), string(map, "desc"), string(map, "status"), optionalString(map.get("note")));
            if (loaded.putIfAbsent(task.id(), task) != null) throw new IllegalArgumentException("Duplicate task id: " + task.id());
            Matcher generated = GENERATED_ID.matcher(task.id());
            if (generated.matches()) candidateNextId = Math.max(candidateNextId, Long.parseLong(generated.group(1)) + 1);
        }
        tasks.clear();
        tasks.putAll(loaded);
        nextId = candidateNextId;
        if (documentId == null && loadedDocumentId != null && !loadedDocumentId.isBlank()) documentId = loadedDocumentId;
    }

    private void persist() throws IOException {
        Path target = persistencePath();
        if (target == null) return;
        Files.createDirectories(target.getParent());
        Path temporary = Files.createTempFile(target.getParent(), documentId + "-", ".tmp");
        try {
            Files.writeString(temporary, toJson(), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static void validateTransition(String from, String to) {
        if (!TRANSITIONS.get(from).contains(to)) {
            throw new IllegalArgumentException("Invalid task status transition: " + from + " -> " + to);
        }
    }

    private static String normalizeStatus(String status) {
        String normalized = required(status, "status").toLowerCase(Locale.ROOT);
        if (!STATUSES.contains(normalized)) throw new IllegalArgumentException("Invalid task status: " + status);
        return normalized;
    }

    private static String required(String value, String field) {
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException(field + " must not be blank");
        return value.trim();
    }

    private static String string(Map<?, ?> map, String key) {
        Object value = map.get(key);
        if (!(value instanceof String text)) throw new IllegalArgumentException(key + " must be a string");
        return text;
    }

    private static String optionalString(Object value) {
        if (value == null) return "";
        if (!(value instanceof String text)) throw new IllegalArgumentException("Expected string");
        return text;
    }

    private static void validateDocumentId(String value) {
        if (value == null || !DOCUMENT_ID.matcher(value).matches() || value.equals(".") || value.equals("..")) {
            throw new IllegalArgumentException("Invalid documentId: " + value);
        }
    }
}
