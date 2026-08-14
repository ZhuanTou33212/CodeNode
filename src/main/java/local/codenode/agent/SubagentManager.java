package local.codenode.agent;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Owns the lifecycle of background agents for one originating conversation.
 * The runner is deliberately injectable so lifecycle behavior stays deterministic
 * and does not depend on a particular model provider.
 */
public final class SubagentManager implements AutoCloseable {
    public static final int DEFAULT_CONCURRENCY_LIMIT = 3;
    public static final int DEFAULT_RESULT_LIMIT = 8_000;

    public enum Status {
        QUEUED,
        RUNNING,
        COMPLETED,
        FAILED,
        CANCELLED;

        public boolean terminal() {
            return this == COMPLETED || this == FAILED || this == CANCELLED;
        }

        public String wireName() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    /** Cooperative cancellation token. Cancellation also interrupts the runner thread. */
    @FunctionalInterface
    public interface Cancellation {
        boolean isCancelled();

        default void throwIfCancelled() throws InterruptedException {
            if (isCancelled()) throw new InterruptedException("subagent cancelled");
        }
    }

    @FunctionalInterface
    public interface Runner {
        String run(String task, String context, Cancellation cancellation) throws Exception;
    }

    public record Snapshot(
            String id,
            String task,
            String context,
            Status status,
            String result,
            String error,
            Instant createdAt,
            Instant startedAt,
            Instant completedAt) {

        public boolean terminal() {
            return status.terminal();
        }

        public Map<String, Object> toMap() {
            LinkedHashMap<String, Object> value = new LinkedHashMap<>();
            value.put("id", id);
            value.put("task", task);
            value.put("context", context);
            value.put("status", status.wireName());
            value.put("result", result);
            value.put("error", error);
            value.put("createdAt", createdAt == null ? "" : createdAt.toString());
            value.put("startedAt", startedAt == null ? "" : startedAt.toString());
            value.put("completedAt", completedAt == null ? "" : completedAt.toString());
            return value;
        }
    }

    public record WaitOutcome(Snapshot subagent, boolean timedOut) {}

    private static final class Entry {
        private final String id;
        private final String task;
        private final String context;
        private final Instant createdAt = Instant.now();
        private final AtomicReference<Status> status = new AtomicReference<>(Status.QUEUED);
        private final AtomicBoolean cancellation = new AtomicBoolean(false);
        private final CompletableFuture<Void> completion = new CompletableFuture<>();
        private volatile Instant startedAt;
        private volatile Instant completedAt;
        private volatile String result = "";
        private volatile String error = "";
        private volatile Future<?> future;

        private Entry(String id, String task, String context) {
            this.id = id;
            this.task = task;
            this.context = context;
        }

        private synchronized Snapshot snapshot() {
            return new Snapshot(id, task, context, status.get(), result, error,
                    createdAt, startedAt, completedAt);
        }

        private synchronized void finish() {
            completedAt = Instant.now();
            completion.complete(null);
        }
    }

    private final Runner runner;
    private final int concurrencyLimit;
    private final int resultLimit;
    private final ExecutorService executor;
    private final Map<String, Entry> entries = new java.util.concurrent.ConcurrentHashMap<>();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public SubagentManager(Runner runner) {
        this(runner, DEFAULT_CONCURRENCY_LIMIT, DEFAULT_RESULT_LIMIT);
    }

    public SubagentManager(Runner runner, int concurrencyLimit, int resultLimit) {
        this.runner = Objects.requireNonNull(runner, "runner");
        if (concurrencyLimit < 1) throw new IllegalArgumentException("concurrencyLimit must be positive");
        if (resultLimit < 1) throw new IllegalArgumentException("resultLimit must be positive");
        this.concurrencyLimit = concurrencyLimit;
        this.resultLimit = resultLimit;
        AtomicInteger sequence = new AtomicInteger();
        ThreadFactory factory = runnable -> {
            Thread thread = new Thread(runnable, "codenode-subagent-" + sequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
        this.executor = Executors.newFixedThreadPool(concurrencyLimit, factory);
    }

    public int concurrencyLimit() {
        return concurrencyLimit;
    }

    public int resultLimit() {
        return resultLimit;
    }

    public String spawn(String task, String context) {
        if (closed.get()) throw new IllegalStateException("subagent manager is closed");
        String actualTask = task == null ? "" : task.trim();
        if (actualTask.isEmpty()) throw new IllegalArgumentException("task must not be blank");
        String id = UUID.randomUUID().toString();
        Entry entry = new Entry(id, actualTask, context == null ? "" : context);
        entries.put(id, entry);
        try {
            entry.future = executor.submit(() -> execute(entry));
        } catch (RuntimeException failure) {
            entries.remove(id);
            throw failure;
        }
        return id;
    }

    public Snapshot get(String id) {
        Entry entry = entries.get(id);
        return entry == null ? null : entry.snapshot();
    }

    public List<Snapshot> list() {
        ArrayList<Snapshot> snapshots = new ArrayList<>();
        for (Entry entry : entries.values()) snapshots.add(entry.snapshot());
        snapshots.sort(Comparator.comparing(Snapshot::createdAt).thenComparing(Snapshot::id));
        return List.copyOf(snapshots);
    }

    public WaitOutcome waitFor(String id, Duration timeout) throws InterruptedException {
        Entry entry = requireEntry(id);
        Duration actual = timeout == null ? Duration.ofSeconds(60) : timeout;
        if (actual.isNegative()) throw new IllegalArgumentException("timeout must not be negative");
        boolean timedOut = false;
        try {
            if (actual.isZero()) {
                if (!entry.completion.isDone()) timedOut = true;
            } else {
                entry.completion.get(actual.toNanos(), TimeUnit.NANOSECONDS);
            }
        } catch (TimeoutException ignored) {
            timedOut = true;
        } catch (ExecutionException impossible) {
            // Entry completion is informational and is always completed normally.
        }
        return new WaitOutcome(entry.snapshot(), timedOut);
    }

    public boolean cancel(String id) {
        Entry entry = entries.get(id);
        if (entry == null) return false;
        synchronized (entry) {
            Status current = entry.status.get();
            if (current.terminal()) return current == Status.CANCELLED;
            entry.status.set(Status.CANCELLED);
            entry.cancellation.set(true);
            Future<?> future = entry.future;
            if (future != null) future.cancel(true);
            entry.finish();
            return true;
        }
    }

    private Entry requireEntry(String id) {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("id must not be blank");
        Entry entry = entries.get(id);
        if (entry == null) throw new IllegalArgumentException("unknown subagent: " + id);
        return entry;
    }

    private void execute(Entry entry) {
        synchronized (entry) {
            if (!entry.status.compareAndSet(Status.QUEUED, Status.RUNNING)) return;
            entry.startedAt = Instant.now();
        }
        try {
            String output = runner.run(entry.task, entry.context, entry.cancellation::get);
            synchronized (entry) {
                if (entry.status.get() != Status.RUNNING) return;
                entry.result = truncate(output == null ? "" : output);
                entry.status.set(Status.COMPLETED);
                entry.finish();
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            completeCancelled(entry);
        } catch (Exception failure) {
            if (entry.cancellation.get()) {
                completeCancelled(entry);
            } else {
                synchronized (entry) {
                    if (entry.status.get() == Status.RUNNING) {
                        entry.error = truncate(failure.getMessage() == null
                                ? failure.getClass().getSimpleName() : failure.getMessage());
                        entry.status.set(Status.FAILED);
                        entry.finish();
                    }
                }
            }
        }
    }

    private void completeCancelled(Entry entry) {
        synchronized (entry) {
            Status previous = entry.status.getAndSet(Status.CANCELLED);
            if (!previous.terminal()) entry.finish();
        }
    }

    private String truncate(String value) {
        if (value.length() <= resultLimit) return value;
        String suffix = "\u2026[truncated]";
        if (suffix.length() >= resultLimit) return value.substring(0, resultLimit);
        return value.substring(0, resultLimit - suffix.length()) + suffix;
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        for (Entry entry : entries.values()) cancel(entry.id);
        executor.shutdownNow();
    }
}
