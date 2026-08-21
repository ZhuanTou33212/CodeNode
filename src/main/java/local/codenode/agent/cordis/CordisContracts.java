package local.codenode.agent.cordis;

import java.util.Map;
import java.util.Set;

/** Stable service/event names exposed to third-party plugins. */
public final class CordisContracts {
    public static final String VERSION = "1.0";

    public static final String SERVICE_CONFIG = "harness.config";
    public static final String SERVICE_CONTEXT = "harness.context";
    public static final String SERVICE_LLM = "harness.llm";
    public static final String SERVICE_TOOLS = "harness.tools";
    public static final String SERVICE_PROMPT = "harness.prompt";
    public static final String SERVICE_COMPACTOR = "harness.compactor";
    public static final String SERVICE_SESSION_STORE = "harness.session-store";
    public static final String SERVICE_SESSION_EVENTS = "harness.session-events";
    public static final String SERVICE_LOOP = "harness.loop";
    public static final String SERVICE_AGENT_LOOP = "harness.agent-loop";
    public static final String SERVICE_AGENTS = "harness.agents";
    public static final String SERVICE_LISTENERS = "harness.listeners";
    public static final String SERVICE_PLANNER = "harness.planner";
    public static final String SERVICE_SANDBOX = "harness.sandbox";
    public static final String SERVICE_UI = "harness.ui";
    public static final String SERVICE_SCHEDULER = "harness.scheduler";
    public static final String SERVICE_SKILLS = "harness.skills";

    public static final Set<String> DURABLE_EVENTS = Set.of(
            "session/start", "session/end", "user/message", "agent/request", "assistant/message",
            "assistant/chunk", "tool/call", "tool/result", "context/injection", "agent/status",
            "agent/retry", "agent/plan-check", "agent/error");

    public static final Map<String, String> SERVICE_TYPES = Map.ofEntries(
            Map.entry(SERVICE_CONFIG, "local.codenode.config.AgentConfig"),
            Map.entry(SERVICE_CONTEXT, "local.codenode.agent.tools.AgentToolContext"),
            Map.entry(SERVICE_LLM, "local.codenode.agent.components.ChatClientFactory"),
            Map.entry(SERVICE_TOOLS, "local.codenode.agent.tools.AgentToolRegistry"),
            Map.entry(SERVICE_PROMPT, "local.codenode.agent.components.PromptAssembler"),
            Map.entry(SERVICE_COMPACTOR, "local.codenode.agent.components.CompactorFactory"),
            Map.entry(SERVICE_SESSION_STORE, "local.codenode.agent.components.SessionStore.Factory"),
            Map.entry(SERVICE_SESSION_EVENTS, "local.codenode.agent.components.SessionEventStore.Factory"),
            Map.entry(SERVICE_LOOP, "local.codenode.agent.components.LoopPolicy.Factory"),
            Map.entry(SERVICE_AGENT_LOOP, "local.codenode.agent.components.AgentLoop"),
            Map.entry(SERVICE_AGENTS, "local.codenode.agent.components.AgentSpawner"),
            Map.entry(SERVICE_LISTENERS, "java.util.List"),
            Map.entry(SERVICE_PLANNER, "java.lang.Integer"),
            Map.entry(SERVICE_SANDBOX, "local.codenode.agent.cordis.SandboxService"),
            Map.entry(SERVICE_UI, "local.codenode.agent.cordis.UiBridge"),
            Map.entry(SERVICE_SCHEDULER, "local.codenode.agent.cordis.SchedulerService"),
            Map.entry(SERVICE_SKILLS, "local.codenode.agent.cordis.SkillRegistry"));

    private CordisContracts() { }

    public static boolean compatible(String version) {
        return VERSION.equals(version == null ? "" : version.trim());
    }
}
