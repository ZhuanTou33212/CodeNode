package local.codenode.agent.cordis;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/** Default process-local scheduler; replaceable by a Cordis plugin. */
public final class DefaultSchedulerService implements SchedulerService {
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final ScheduledExecutorService scheduled = Executors.newScheduledThreadPool(2);

    @Override public ExecutorService executor() { return executor; }
    @Override public ScheduledExecutorService scheduledExecutor() { return scheduled; }
    @Override public void close() { scheduled.shutdownNow(); executor.shutdownNow(); }
}
