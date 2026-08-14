package local.codenode.agent.tools.impl;

import local.codenode.agent.SubagentManager;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Tools for delegating bounded background work from the current conversation. */
public final class SubagentTools {
    private SubagentTools() {}

    public static void register(AgentToolRegistry registry) {
        registry.register("spawn_subagent",
                "Start an independent background agent for a focused task. Returns immediately with its id.",
                schema(Map.of(
                        "task", string("Focused task for the subagent"),
                        "context", string("Optional relevant project, file, or graph context")), List.of("task")),
                SubagentTools::spawn);
        registry.register("subagent_wait",
                "Wait for a subagent to finish, fail, or be cancelled. A timeout does not cancel it.",
                schema(Map.of(
                        "id", string("Subagent id"),
                        "timeoutSeconds", integer("Wait timeout in seconds, default 60, maximum 600")), List.of("id")),
                SubagentTools::waitFor);
        registry.register("subagent_list", "List subagents owned by the current conversation.",
                schema(Map.of(), List.of()), SubagentTools::list);
        registry.register("subagent_cancel", "Cancel a queued or running subagent.",
                schema(Map.of("id", string("Subagent id")), List.of("id")), SubagentTools::cancel);
    }

    private static AgentToolResult spawn(AgentToolContext context, Map<String, Object> args) {
        SubagentManager manager = manager(context);
        if (manager == null) return unavailable();
        String task = String.valueOf(args.get("task"));
        String relevantContext = args.get("context") instanceof String value ? value : "";
        String id = manager.spawn(task, relevantContext);
        SubagentManager.Snapshot snapshot = manager.get(id);
        context.audit("spawn_subagent id=" + id);
        return AgentToolResult.ok("Subagent queued: " + id, Map.of("subagent", snapshot.toMap()));
    }

    private static AgentToolResult waitFor(AgentToolContext context, Map<String, Object> args) throws InterruptedException {
        SubagentManager manager = manager(context);
        if (manager == null) return unavailable();
        int seconds = args.get("timeoutSeconds") instanceof Number number ? number.intValue() : 60;
        if (seconds < 0 || seconds > 600) return AgentToolResult.error("timeoutSeconds must be between 0 and 600");
        SubagentManager.WaitOutcome outcome = manager.waitFor(String.valueOf(args.get("id")), Duration.ofSeconds(seconds));
        LinkedHashMap<String, Object> data = new LinkedHashMap<>();
        data.put("timedOut", outcome.timedOut());
        data.put("subagent", outcome.subagent().toMap());
        String text = outcome.timedOut() ? "Subagent is still running" : "Subagent is " + outcome.subagent().status().wireName();
        return AgentToolResult.ok(text, data);
    }

    private static AgentToolResult list(AgentToolContext context, Map<String, Object> args) {
        SubagentManager manager = manager(context);
        if (manager == null) return unavailable();
        List<Map<String, Object>> items = manager.list().stream().map(SubagentManager.Snapshot::toMap).toList();
        return AgentToolResult.ok(items.size() + " subagent(s)", Map.of("subagents", items));
    }

    private static AgentToolResult cancel(AgentToolContext context, Map<String, Object> args) {
        SubagentManager manager = manager(context);
        if (manager == null) return unavailable();
        String id = String.valueOf(args.get("id"));
        SubagentManager.Snapshot before = manager.get(id);
        if (before == null) return AgentToolResult.error("Unknown subagent: " + id);
        boolean cancelled = manager.cancel(id);
        context.audit("subagent_cancel id=" + id + " cancelled=" + cancelled);
        return AgentToolResult.ok(cancelled ? "Subagent cancelled" : "Subagent already finished",
                Map.of("cancelled", cancelled, "subagent", manager.get(id).toMap()));
    }

    private static SubagentManager manager(AgentToolContext context) {
        return context == null ? null : context.subagentManager();
    }

    private static AgentToolResult unavailable() {
        return AgentToolResult.error("Subagents are not available in this conversation");
    }

    private static Map<String, Object> schema(Map<String, Object> properties, List<String> required) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("type", "object");
        result.put("properties", properties);
        result.put("required", required);
        return result;
    }

    private static Map<String, Object> string(String description) {
        return Map.of("type", "string", "description", description);
    }

    private static Map<String, Object> integer(String description) {
        return Map.of("type", "integer", "description", description);
    }
}
