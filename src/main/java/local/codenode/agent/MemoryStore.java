package local.codenode.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

/**
 * Project-local memory with an explicit durable/temporary split.
 *
 * <p>Durable entries are Markdown files under {@code .codenode/memory/<hash>/} and
 * survive application restarts.  Temporary entries live below {@code cache/} and
 * are removed when a project is rebound or the application closes.  Cleanup is
 * deterministic and bounded by both TTL and total byte size.</p>
 */
public final class MemoryStore implements AutoCloseable {
    public static final long DEFAULT_MAX_BYTES = 8L * 1024 * 1024;
    public static final int DEFAULT_MAX_ENTRIES = 256;
    public static final Duration DEFAULT_TTL = Duration.ofDays(30);

    private final long maxBytes;
    private final int maxEntries;
    private final Duration ttl;
    private Path projectRoot;
    private Path memoryRoot;
    private Path cacheRoot;

    public MemoryStore() {
        this(DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_TTL);
    }

    public MemoryStore(long maxBytes, int maxEntries, Duration ttl) {
        if (maxBytes < 1024) throw new IllegalArgumentException("maxBytes must be at least 1024");
        if (maxEntries < 1) throw new IllegalArgumentException("maxEntries must be positive");
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.ttl = Objects.requireNonNull(ttl, "ttl");
        if (ttl.isNegative() || ttl.isZero()) throw new IllegalArgumentException("ttl must be positive");
    }

    /** Bind this store to a project and run startup cleanup for that project. */
    public synchronized void bind(Path root) throws IOException {
        Path normalized = Objects.requireNonNull(root, "root").toAbsolutePath().normalize();
        if (normalized.equals(projectRoot) && memoryRoot != null) return;
        clearTransientCache();
        projectRoot = normalized;
        Path base = normalized.resolve(".codenode").resolve("memory");
        memoryRoot = base.resolve(hash(normalized.toString()));
        cacheRoot = memoryRoot.resolve("cache");
        Files.createDirectories(memoryRoot);
        Files.createDirectories(cacheRoot);
        cleanup();
    }

    public synchronized Path directory() {
        return memoryRoot;
    }

    public synchronized Entry remember(String title, String content, String source) {
        ensureBound();
        String body = content == null ? "" : content.trim();
        if (body.isBlank()) return null;
        String safeTitle = sanitize(title == null ? "memory" : title);
        String id = Instant.now().toEpochMilli() + "-" + UUID.randomUUID().toString().substring(0, 8);
        Path target = memoryRoot.resolve(safeTitle + "-" + id + ".md");
        String markdown = "# " + (title == null || title.isBlank() ? "记忆" : title.trim()) + "\n\n"
                + "<!-- source: " + sanitizeInline(source) + " -->\n"
                + body + "\n";
        try {
            atomicWrite(target, markdown);
            cleanup();
            return entry(target);
        } catch (IOException failure) {
            throw new IllegalStateException("无法写入本地记忆：" + failure.getMessage(), failure);
        }
    }

    /** Write a bounded temporary cache entry. It is never returned by durable recall. */
    public synchronized void putCache(String key, String content) {
        ensureBound();
        String safe = sanitize(key == null ? "cache" : key);
        Path target = cacheRoot.resolve(safe + ".md");
        try {
            atomicWrite(target, content == null ? "" : content);
        } catch (IOException failure) {
            throw new IllegalStateException("无法写入记忆缓存：" + failure.getMessage(), failure);
        }
    }

    public synchronized List<Entry> list() {
        ensureBound();
        try (var stream = Files.list(memoryRoot)) {
            return stream.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".md"))
                    .map(this::safeEntry)
                    .filter(Objects::nonNull)
                    .sorted(Comparator.comparing(Entry::updatedAt).reversed())
                    .toList();
        } catch (IOException failure) {
            return List.of();
        }
    }

    public synchronized List<Entry> recall(String query, int limit) {
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        int max = Math.max(1, Math.min(50, limit));
        return list().stream()
                .filter(entry -> needle.isBlank()
                        || entry.title().toLowerCase(Locale.ROOT).contains(needle)
                        || entry.content().toLowerCase(Locale.ROOT).contains(needle))
                .limit(max)
                .toList();
    }

    /** Delete temporary cache files only; durable Markdown remains intact. */
    public synchronized void clearTransientCache() {
        if (cacheRoot == null || !Files.isDirectory(cacheRoot)) return;
        try (var stream = Files.list(cacheRoot)) {
            for (Path child : stream.toList()) {
                if (Files.isRegularFile(child)) Files.deleteIfExists(child);
            }
        } catch (IOException ignored) {
            // Cleanup is best effort and must never prevent project opening/closing.
        }
    }

    /** Remove expired entries and oldest entries until both configured bounds hold. */
    public synchronized void cleanup() {
        if (memoryRoot == null || !Files.isDirectory(memoryRoot)) return;
        clearTransientCache();
        Instant cutoff = Instant.now().minus(ttl);
        List<Entry> entries = new ArrayList<>(list());
        for (Entry entry : entries) {
            if (entry.updatedAt().isBefore(cutoff)) {
                try { Files.deleteIfExists(entry.path()); } catch (IOException ignored) { }
            }
        }
        entries = new ArrayList<>(list());
        long total = entries.stream().mapToLong(Entry::bytes).sum();
        while (entries.size() > maxEntries || total > maxBytes) {
            Entry oldest = entries.remove(entries.size() - 1);
            try { Files.deleteIfExists(oldest.path()); } catch (IOException ignored) { }
            total -= oldest.bytes();
        }
    }

    @Override
    public synchronized void close() {
        clearTransientCache();
    }

    private Entry safeEntry(Path path) {
        try { return entry(path); } catch (IOException ignored) { return null; }
    }

    private Entry entry(Path path) throws IOException {
        String file = Files.readString(path, StandardCharsets.UTF_8);
        String title = file.lines().findFirst().orElse("").replaceFirst("^#\\s*", "").trim();
        Instant updated = Files.getLastModifiedTime(path).toInstant();
        return new Entry(path, title, file, Files.size(path), updated);
    }

    private void ensureBound() {
        if (memoryRoot == null) throw new IllegalStateException("MemoryStore 尚未绑定项目");
    }

    private static void atomicWrite(Path target, String value) throws IOException {
        Files.createDirectories(target.getParent());
        Path temp = target.resolveSibling(target.getFileName() + ".tmp-" + UUID.randomUUID());
        try {
            Files.writeString(temp, value, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            try { Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (java.nio.file.AtomicMoveNotSupportedException ignored) { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING); }
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private static String sanitize(String value) {
        String safe = value == null ? "memory" : value.trim().replaceAll("[^A-Za-z0-9._-]+", "_");
        if (safe.isBlank()) safe = "memory";
        return safe.length() > 80 ? safe.substring(0, 80) : safe;
    }

    private static String sanitizeInline(String value) {
        return value == null ? "" : value.replace("--", "-").replace('\n', ' ').replace('\r', ' ');
    }

    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))).substring(0, 24); }
        catch (Exception failure) { throw new IllegalStateException(failure); }
    }

    public record Entry(Path path, String title, String content, long bytes, Instant updatedAt) { }
}
