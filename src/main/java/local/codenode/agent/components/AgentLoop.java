package local.codenode.agent.components;

import local.codenode.config.AgentConfig;

/** Replaceable driver for one agent turn; the loop body remains an injectable capability. */
@FunctionalInterface
public interface AgentLoop {
    void run(ThrowingTask task) throws Exception;

    @FunctionalInterface
    interface ThrowingTask {
        void run() throws Exception;
    }

    @FunctionalInterface
    interface Factory {
        AgentLoop create(AgentConfig config);
    }
}
