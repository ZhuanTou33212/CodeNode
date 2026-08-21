package local.codenode.agent.components;

import local.codenode.agent.SubagentManager;
import local.codenode.config.AgentConfig;

/** Factory seam for the subagent scheduler/service. */
@FunctionalInterface
public interface AgentSpawner {
    SubagentManager create(SubagentManager.Runner runner);

    @FunctionalInterface
    interface Factory {
        AgentSpawner create(AgentConfig config);
    }
}
