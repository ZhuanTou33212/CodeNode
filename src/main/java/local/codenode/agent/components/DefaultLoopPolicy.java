package local.codenode.agent.components;

import local.codenode.config.AgentConfig;

import java.util.Map;

/** 默认 ReAct loop 策略，保留改造前的行为并将 tunables 移入配置。 */
public final class DefaultLoopPolicy implements LoopPolicy {

    private static final int DEFAULT_MAX_ROUNDS = 10;
    private static final int DEFAULT_MAX_RETRIES = 5;
    private static final int DEFAULT_TOOL_TIMEOUT_SECONDS = 60;
    private static final int LONG_TOOL_TIMEOUT_SECONDS = 300;
    private static final int MAX_TOOL_TIMEOUT_SECONDS = 600;

    private final int maxToolRounds;
    private final int maxToolRetries;
    private final int defaultToolTimeoutSeconds;
    private final int longToolTimeoutSeconds;

    public DefaultLoopPolicy(AgentConfig config) {
        this.maxToolRounds = positive(config.loopMaxRounds(), DEFAULT_MAX_ROUNDS);
        this.maxToolRetries = Math.max(0, config.loopMaxRetries());
        this.defaultToolTimeoutSeconds = bounded(config.loopDefaultTimeoutSeconds(), DEFAULT_TOOL_TIMEOUT_SECONDS);
        this.longToolTimeoutSeconds = bounded(config.loopLongTimeoutSeconds(), LONG_TOOL_TIMEOUT_SECONDS);
    }

    @Override
    public int maxToolRounds() {
        return maxToolRounds;
    }

    @Override
    public int maxToolRetries() {
        return maxToolRetries;
    }

    @Override
    public long resolveToolTimeout(String name, Map<String, Object> args) {
        Object explicit = args == null ? null : args.get("timeoutSeconds");
        if (explicit instanceof Number number) {
            return Math.max(1, Math.min(MAX_TOOL_TIMEOUT_SECONDS, number.longValue()));
        }
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.contains("build") || lower.contains("run") || lower.contains("compile")
                || lower.contains("trace") || lower.contains("scan") || lower.contains("fetch")
                || lower.contains("shell") || lower.contains("url")) {
            return longToolTimeoutSeconds;
        }
        return defaultToolTimeoutSeconds;
    }

    private static int positive(int value, int fallback) {
        return value > 0 ? value : fallback;
    }

    private static int bounded(int value, int fallback) {
        return Math.min(MAX_TOOL_TIMEOUT_SECONDS, positive(value, fallback));
    }
}
