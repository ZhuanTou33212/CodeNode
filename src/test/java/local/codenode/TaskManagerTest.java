package local.codenode;

import local.codenode.agent.TaskManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.*;

class TaskManagerTest {
    @TempDir Path tempDir;

    @Test void crudPersistsAndRoundTripsWithSchema() throws Exception {
        TaskManager manager = new TaskManager(tempDir, "document-42");
        TaskManager.Task first = manager.add("Scan project");
        TaskManager.Task second = manager.add("Analyze architecture", "in_progress", "started");

        assertEquals("t1", first.id());
        assertEquals("pending", first.status());
        assertEquals("t2", second.id());
        manager.update(first.id(), null, "done", "120 nodes");

        Path file = tempDir.resolve(".codenode/tasks/document-42.json");
        assertTrue(Files.isRegularFile(file));
        Map<String, Object> json = Json.object(Files.readString(file, StandardCharsets.UTF_8));
        assertEquals(TaskManager.FORMAT, json.get("format"));
        assertEquals(1L, json.get("schemaVersion"));
        assertEquals("document-42", json.get("documentId"));

        TaskManager restored = new TaskManager(tempDir, "document-42");
        assertEquals(manager.list(), restored.list());
        assertEquals("t3", restored.add("Write report").id());
        assertEquals(3, restored.list().size());
    }

    @Test void validatesStatusesTransitionsAndDocumentIds() throws Exception {
        TaskManager manager = new TaskManager(tempDir, "safe-id");
        TaskManager.Task task = manager.add("Implement feature");
        assertThrows(IllegalArgumentException.class,
                () -> manager.update(task.id(), null, "unknown", null));
        manager.update(task.id(), null, "done", null);
        assertThrows(IllegalArgumentException.class,
                () -> manager.update(task.id(), null, "in_progress", null));
        assertEquals("pending", manager.update(task.id(), null, "pending", "reopened").status());
        assertThrows(IllegalArgumentException.class,
                () -> new TaskManager(tempDir, "../escape"));
    }

    @Test void clearPersistsAndMalformedOrMismatchedFilesAreRejected() throws Exception {
        TaskManager manager = new TaskManager(tempDir, "clear-doc");
        manager.add("One");
        manager.add("Two");
        assertEquals(2, manager.clear());
        assertTrue(new TaskManager(tempDir, "clear-doc").list().isEmpty());

        Path directory = tempDir.resolve(".codenode/tasks");
        Files.writeString(directory.resolve("bad.json"),
                "{\"format\":\"codenode-tasks\",\"schemaVersion\":99,\"documentId\":\"bad\",\"tasks\":[]}",
                StandardCharsets.UTF_8);
        assertThrows(IllegalArgumentException.class, () -> new TaskManager(tempDir, "bad"));

        Files.writeString(directory.resolve("mismatch.json"),
                "{\"format\":\"codenode-tasks\",\"schemaVersion\":1,\"documentId\":\"other\",\"tasks\":[]}",
                StandardCharsets.UTF_8);
        assertThrows(IllegalArgumentException.class, () -> new TaskManager(tempDir, "mismatch"));
    }

    @Test void unboundManagerSerializesAndLoadsInMemory() throws Exception {
        TaskManager manager = new TaskManager();
        manager.add("Plan", "blocked", "waiting");
        TaskManager restored = TaskManager.fromJson(manager.toJson());
        assertEquals(manager.list(), restored.list());
        assertFalse(restored.isBound());
    }

    @Test void concurrentAddsRemainUniqueAndPersistEveryTask() throws Exception {
        TaskManager manager = new TaskManager(tempDir, "concurrent-doc");
        try (var executor = Executors.newFixedThreadPool(8)) {
            var calls = java.util.stream.IntStream.range(0, 40)
                    .<java.util.concurrent.Callable<TaskManager.Task>>mapToObj(i -> () -> manager.add("Task " + i))
                    .toList();
            var results = executor.invokeAll(calls);
            assertEquals(40, results.stream().map(future -> {
                try { return future.get().id(); }
                catch (Exception failure) { throw new AssertionError(failure); }
            }).distinct().count());
        }
        assertEquals(40, manager.list().size());
        assertEquals(manager.list(), new TaskManager(tempDir, "concurrent-doc").list());
    }
}
