package local.codenode.agent.cordis;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;

/** Scheduling capability shared by loops, subagents, and plugins. */
public interface SchedulerService extends AutoCloseable {
    ExecutorService executor();
    ScheduledExecutorService scheduledExecutor();
    @Override void close();
}
