package local.codenode;

import local.codenode.agent.MemoryStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

class MemoryStoreTest {
    @Test void durableMarkdownAndTransientCacheAreSeparated(@TempDir java.nio.file.Path root) throws Exception {
        MemoryStore store = new MemoryStore(4096, 4, Duration.ofDays(30));
        store.bind(root);
        MemoryStore.Entry saved = store.remember("Release notes", "remember this decision", "conversation");
        assertNotNull(saved);
        assertTrue(saved.path().toString().endsWith(".md"));
        assertEquals(1, store.recall("decision", 10).size());
        store.putCache("prompt", "temporary");
        assertTrue(Files.exists(store.directory().resolve("cache/prompt.md")));
        store.cleanup();
        assertFalse(Files.exists(store.directory().resolve("cache/prompt.md")));
        assertEquals(1, store.list().size());
    }

    @Test void cleanupEnforcesTtlAndEntryCount(@TempDir java.nio.file.Path root) throws Exception {
        MemoryStore store = new MemoryStore(4096, 1, Duration.ofDays(1));
        store.bind(root);
        MemoryStore.Entry old = store.remember("old", "old content", "test");
        Files.setLastModifiedTime(old.path(), FileTime.from(Instant.now().minus(Duration.ofDays(2))));
        store.cleanup();
        assertTrue(store.list().isEmpty());
        store.remember("one", "1", "test");
        store.remember("two", "2", "test");
        assertEquals(1, store.list().size());
    }
}
