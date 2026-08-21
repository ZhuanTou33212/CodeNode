package local.codenode.agent.components;

/** Default driver preserves CodeNode's existing ReAct turn semantics. */
public final class DefaultAgentLoop implements AgentLoop {
    @Override
    public void run(ThrowingTask task) throws Exception {
        if (task == null) throw new IllegalArgumentException("loop task is null");
        task.run();
    }
}
