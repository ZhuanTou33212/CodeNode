package local.codenode.agent.components;

import local.codenode.config.AgentConfig;

import java.util.Map;

/** Agent loop 的可替换运行策略：轮数、失败自愈次数与工具超时。 */
public interface LoopPolicy {

    int maxToolRounds();

    int maxToolRetries();

    long resolveToolTimeout(String toolName, Map<String, Object> arguments);

    @FunctionalInterface
    interface Factory {
        LoopPolicy create(AgentConfig config);
    }
}
