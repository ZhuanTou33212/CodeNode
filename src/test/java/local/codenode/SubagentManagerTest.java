package local.codenode;

import local.codenode.agent.SubagentManager;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class SubagentManagerTest {
    @Test void lifecycleCompletesAndTruncatesResult() throws Exception {
        try (SubagentManager manager = new SubagentManager(
                (task, context, cancellation) -> task + ":" + context + ":" + "x".repeat(100), 2, 32)) {
            String id = manager.spawn("inspect auth", "src/Auth.java");
            SubagentManager.WaitOutcome outcome = manager.waitFor(id, Duration.ofSeconds(2));

            assertFalse(outcome.timedOut());
            assertEquals(SubagentManager.Status.COMPLETED, outcome.subagent().status());
            assertEquals(32, outcome.subagent().result().length());
            assertTrue(outcome.subagent().result().endsWith("\u2026[truncated]"));
            assertEquals("inspect auth", outcome.subagent().task());
        }
    }

    @Test void failureIsCapturedInsteadOfEscapingWorker() throws Exception {
        try (SubagentManager manager = new SubagentManager((task, context, cancellation) -> {
            throw new IllegalStateException("provider unavailable");
        })) {
            String id = manager.spawn("task", "");
            SubagentManager.Snapshot snapshot = manager.waitFor(id, Duration.ofSeconds(2)).subagent();
            assertEquals(SubagentManager.Status.FAILED, snapshot.status());
            assertEquals("provider unavailable", snapshot.error());
            assertTrue(snapshot.terminal());
        }
    }

    @Test void concurrencyLimitKeepsExcessWorkQueued() throws Exception {
        CountDownLatch firstTwoStarted = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maximum = new AtomicInteger();
        try (SubagentManager manager = new SubagentManager((task, context, cancellation) -> {
            int now = active.incrementAndGet();
            maximum.accumulateAndGet(now, Math::max);
            firstTwoStarted.countDown();
            try {
                while (!release.await(20, TimeUnit.MILLISECONDS)) cancellation.throwIfCancelled();
                return task;
            } finally {
                active.decrementAndGet();
            }
        }, 2, 100)) {
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < 5; i++) ids.add(manager.spawn("task-" + i, ""));
            assertTrue(firstTwoStarted.await(2, TimeUnit.SECONDS));
            assertEquals(2, manager.list().stream().filter(s -> s.status() == SubagentManager.Status.RUNNING).count());
            assertEquals(3, manager.list().stream().filter(s -> s.status() == SubagentManager.Status.QUEUED).count());
            release.countDown();
            for (String id : ids) assertFalse(manager.waitFor(id, Duration.ofSeconds(2)).timedOut());
            assertEquals(2, maximum.get());
            assertTrue(manager.list().stream().allMatch(s -> s.status() == SubagentManager.Status.COMPLETED));
        }
    }

    @Test void waitTimeoutDoesNotCancelAndExplicitCancelInterruptsRunner() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch interrupted = new CountDownLatch(1);
        try (SubagentManager manager = new SubagentManager((task, context, cancellation) -> {
            started.countDown();
            try {
                while (true) {
                    cancellation.throwIfCancelled();
                    Thread.sleep(50);
                }
            } catch (InterruptedException failure) {
                interrupted.countDown();
                throw failure;
            }
        }, 1, 100)) {
            String id = manager.spawn("long task", "");
            assertTrue(started.await(2, TimeUnit.SECONDS));
            SubagentManager.WaitOutcome timeout = manager.waitFor(id, Duration.ofMillis(5));
            assertTrue(timeout.timedOut());
            assertEquals(SubagentManager.Status.RUNNING, timeout.subagent().status());

            assertTrue(manager.cancel(id));
            assertTrue(interrupted.await(2, TimeUnit.SECONDS));
            SubagentManager.WaitOutcome cancelled = manager.waitFor(id, Duration.ofSeconds(1));
            assertFalse(cancelled.timedOut());
            assertEquals(SubagentManager.Status.CANCELLED, cancelled.subagent().status());
        }
    }

    @Test void queuedTaskCanBeCancelledWithoutRunning() throws Exception {
        CountDownLatch running = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger runs = new AtomicInteger();
        try (SubagentManager manager = new SubagentManager((task, context, cancellation) -> {
            runs.incrementAndGet();
            running.countDown();
            release.await();
            return task;
        }, 1, 100)) {
            String first = manager.spawn("first", "");
            assertTrue(running.await(2, TimeUnit.SECONDS));
            String queued = manager.spawn("queued", "");
            assertEquals(SubagentManager.Status.QUEUED, manager.get(queued).status());
            assertTrue(manager.cancel(queued));
            release.countDown();
            assertEquals(SubagentManager.Status.COMPLETED,
                    manager.waitFor(first, Duration.ofSeconds(2)).subagent().status());
            assertEquals(SubagentManager.Status.CANCELLED, manager.get(queued).status());
            assertEquals(1, runs.get());
        }
    }
}
