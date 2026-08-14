package local.codenode.agent.tools.impl;

import local.codenode.agent.TaskManager;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Task-list tools backed by the current document's shared TaskManager. */
public final class TodoTools {
    private TodoTools() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("todo_list", "List the current document's agent tasks.",
                schema(Map.of(), List.of()), TodoTools::list);
        registry.register("todo_add", "Add a task to the shared task list.",
                schema(Map.of(
                        "desc", string("Task description"),
                        "status", string("Optional initial status: pending, in_progress, blocked, done, cancelled"),
                        "note", string("Optional task note")), List.of("desc")), TodoTools::add);
        registry.register("todo_update", "Update a task description, status, or note.",
                schema(Map.of(
                        "id", string("Task id"),
                        "desc", string("Replacement description"),
                        "status", string("New status: pending, in_progress, blocked, done, cancelled"),
                        "note", string("Replacement note")), List.of("id")), TodoTools::update);
        registry.register("todo_clear", "Clear all tasks for the current document.",
                schema(Map.of(), List.of()), TodoTools::clear);
    }

    private static AgentToolResult list(AgentToolContext context, Map<String, Object> arguments) {
        TaskManager manager = manager(context);
        return result("Task list contains " + manager.list().size() + " item(s).", manager);
    }

    private static AgentToolResult add(AgentToolContext context, Map<String, Object> arguments) throws Exception {
        TaskManager manager = manager(context);
        String desc = text(arguments, "desc", null);
        String status = text(arguments, "status", "pending");
        String note = text(arguments, "note", "");
        TaskManager.Task task = manager.add(desc, status, note);
        context.audit("todo_add id=" + task.id() + " status=" + task.status());
        return result("Added task " + task.id() + ".", manager, task);
    }

    private static AgentToolResult update(AgentToolContext context, Map<String, Object> arguments) throws Exception {
        if (!arguments.containsKey("desc") && !arguments.containsKey("status") && !arguments.containsKey("note")) {
            return AgentToolResult.error("todo_update requires desc, status, or note");
        }
        TaskManager manager = manager(context);
        String id = text(arguments, "id", null);
        TaskManager.Task task = manager.update(id,
                nullableText(arguments, "desc"),
                nullableText(arguments, "status"),
                nullableText(arguments, "note"));
        context.audit("todo_update id=" + task.id() + " status=" + task.status());
        return result("Updated task " + task.id() + ".", manager, task);
    }

    private static AgentToolResult clear(AgentToolContext context, Map<String, Object> arguments) throws Exception {
        TaskManager manager = manager(context);
        int count = manager.clear();
        context.audit("todo_clear count=" + count);
        return result("Cleared " + count + " task(s).", manager);
    }

    private static TaskManager manager(AgentToolContext context) {
        if (context == null) throw new IllegalStateException("Agent tool context is unavailable");
        TaskManager manager = context.taskManager();
        if (manager == null) throw new IllegalStateException("Task manager is unavailable");
        return manager;
    }

    private static AgentToolResult result(String text, TaskManager manager) {
        return result(text, manager, null);
    }

    private static AgentToolResult result(String text, TaskManager manager, TaskManager.Task task) {
        List<TaskManager.Task> snapshot = manager.list();
        LinkedHashMap<String, Object> data = new LinkedHashMap<>();
        if (task != null) data.put("task", task.toMap());
        data.put("tasks", snapshot.stream().map(TaskManager.Task::toMap).toList());
        data.put("count", snapshot.size());
        return AgentToolResult.ok(text, data);
    }

    private static String text(Map<String, Object> arguments, String key, String fallback) {
        Object value = arguments.get(key);
        if (value == null) return fallback;
        return String.valueOf(value).trim();
    }

    private static String nullableText(Map<String, Object> arguments, String key) {
        return arguments.containsKey(key) ? text(arguments, key, "") : null;
    }

    private static Map<String, Object> string(String description) {
        return Map.of("type", "string", "description", description);
    }

    private static Map<String, Object> schema(Map<String, Object> properties, List<String> required) {
        return Map.of("type", "object", "properties", properties, "required", required);
    }
}
