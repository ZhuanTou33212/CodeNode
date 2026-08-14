package local.codenode.agent.tools.impl;

import local.codenode.Json;
import local.codenode.WorkflowDslService;
import local.codenode.WorkflowModel;
import local.codenode.agent.knowledge.ConversationGraphParser;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Deterministic knowledge-graph tools exposed to the embedded agent. */
public final class GraphTools {
    private GraphTools() {}

    public static void register(AgentToolRegistry registry) {
        registry.register("graph_root", "读取当前项目长期知识图谱的根元素与顶层摘要。",
                schema(Map.of(), List.of()), GraphTools::root);
        registry.register("graph_query", "按元素 id、标题、摘要、关键词或定位查询当前项目知识图谱。",
                schema(Map.of("query", string("检索词或元素 id"), "layer", integer("可选层级")), List.of("query")), GraphTools::query);
        registry.register("graph_traverse", "从指定知识元素向下遍历直接子层。",
                schema(Map.of("rootId", string("起始元素 id"), "depth", integer("向下深度，默认 2")), List.of("rootId")), GraphTools::traverse);
        registry.register("graph_path", "读取元素的真实来源定位。",
                schema(Map.of("elementId", string("元素 id")), List.of("elementId")), GraphTools::path);
        registry.register("graph_summarize", "把长文本分块摘要并固化到当前项目；检测到与既有长期知识冲突时必须确认。",
                schema(Map.of("text", string("要固化的长文本，可省略以使用当前会话"),
                        "source", string("来源定位"), "includeCanvas", bool("是否附加画布上下文，默认 true")), List.of()), GraphTools::summarize);
        registry.register("graph_conflicts", "读取当前项目长期知识中尚未解决的冲突，返回来源、时间和新旧值。",
                schema(Map.of("includeResolved", bool("是否包含已接受或拒绝的历史冲突，默认 false")), List.of()), GraphTools::conflicts);
        registry.register("graph_resolve_conflict", "在用户确认后接受或拒绝一条长期知识冲突。",
                schema(Map.of("conflictId", string("graph_conflicts 返回的冲突 ID"), "decision", string("accept 或 reject")), List.of("conflictId", "decision")), GraphTools::resolveConflict);
    }

    private static AgentToolResult root(AgentToolContext context, Map<String, Object> args) {
        KnowledgeGraph graph = context.knowledgeGraph();
        return AgentToolResult.ok(graph.overview(), Map.of("roots", graph.roots(), "size", graph.size(),
                "elements", graph.query("", 0).stream().map(KnowledgeGraph.Element::toMap).toList()));
    }

    private static AgentToolResult query(AgentToolContext context, Map<String, Object> args) {
        String query = String.valueOf(args.get("query"));
        Integer layer = args.get("layer") instanceof Number number ? number.intValue() : null;
        List<Map<String, Object>> matches = context.knowledgeGraph().query(query, layer).stream()
                .map(KnowledgeGraph.Element::toMap).toList();
        if (matches.isEmpty()) return AgentToolResult.error("知识图谱未命中：" + query,
                Map.of("query", query, "matches", List.of()));
        return AgentToolResult.ok("知识图谱命中 " + matches.size() + " 项", Map.of("query", query, "matches", matches));
    }

    private static AgentToolResult traverse(AgentToolContext context, Map<String, Object> args) {
        String rootId = String.valueOf(args.get("rootId"));
        int depth = args.get("depth") instanceof Number number ? number.intValue() : 2;
        List<Map<String, Object>> elements = context.knowledgeGraph().traverse(rootId, depth).stream()
                .map(KnowledgeGraph.Element::toMap).toList();
        return AgentToolResult.ok("已遍历 " + elements.size() + " 个知识元素",
                Map.of("rootId", rootId, "depth", depth, "elements", elements));
    }

    private static AgentToolResult path(AgentToolContext context, Map<String, Object> args) {
        String id = String.valueOf(args.get("elementId"));
        KnowledgeGraph.Element element = context.knowledgeGraph().get(id);
        if (element == null) return AgentToolResult.error("知识元素不存在：" + id);
        return AgentToolResult.ok("元素定位：" + element.location(),
                Map.of("element", element.toMap(), "location", element.location()));
    }

    private static AgentToolResult summarize(AgentToolContext context, Map<String, Object> args) {
        String text = args.get("text") instanceof String value ? value.trim() : conversationText(context);
        if (text.isBlank()) return AgentToolResult.error("没有可摘要的文本；请提供 text 或先进行对话");
        boolean includeCanvas = !Boolean.FALSE.equals(args.get("includeCanvas"));
        String canvas = includeCanvas ? canvasContext(context) : "";
        String source = args.get("source") instanceof String value && !value.isBlank() ? value : "conversation";
        KnowledgeGraph fragment = new ConversationGraphParser().parse(text, canvas, source);
        KnowledgeGraph graph = context.knowledgeGraph();
        List<KnowledgeGraph.Conflict> conflicts = graph.detectConflicts(fragment);
        if (!conflicts.isEmpty()) {
            graph.recordConflicts(conflicts);
            boolean confirmed = context.confirm(AgentToolContext.ConfirmationLevel.WRITE,
                    "更新项目长期知识", conflictDetail(conflicts));
            if (!confirmed) {
                context.saveProject();
                return AgentToolResult.error("检测到长期知识冲突，未更新；请确认后调用 graph_resolve_conflict。", Map.of(
                        "requiresConfirmation", true,
                        "conflicts", conflicts.stream().map(KnowledgeGraph.Conflict::toMap).toList()));
            }
            graph.mergeApproved(fragment);
        } else {
            graph.merge(fragment);
        }
        context.audit("graph_summarize chars=" + text.length() + " elements=" + fragment.size());
        context.memoryStore().remember("graph-summarize", fragment.overview(), source);
        context.saveProject();
        return AgentToolResult.ok("长期知识已摘要并固化；冲突已记录来源和替代关系。",
                Map.of("roots", fragment.roots(), "elements", fragment.elements().stream()
                        .map(KnowledgeGraph.Element::toMap).toList(), "dsl", fragment.toDsl(),
                        "conflicts", conflicts.stream().map(KnowledgeGraph.Conflict::toMap).toList()));
    }

    private static AgentToolResult conflicts(AgentToolContext context, Map<String, Object> args) {
        boolean includeResolved = Boolean.TRUE.equals(args.get("includeResolved"));
        List<KnowledgeGraph.Conflict> items = includeResolved
                ? context.knowledgeGraph().conflicts() : context.knowledgeGraph().pendingConflicts();
        return AgentToolResult.ok(items.isEmpty() ? "当前没有长期知识冲突。" : "已找到 " + items.size() + " 条长期知识冲突。",
                Map.of("conflicts", items.stream().map(KnowledgeGraph.Conflict::toMap).toList()));
    }

    private static AgentToolResult resolveConflict(AgentToolContext context, Map<String, Object> args) {
        String id = String.valueOf(args.get("conflictId"));
        String decision = String.valueOf(args.get("decision")).trim().toLowerCase(java.util.Locale.ROOT);
        if (!decision.equals("accept") && !decision.equals("reject")) {
            return AgentToolResult.error("decision 必须是 accept 或 reject");
        }
        if (!context.confirm(AgentToolContext.ConfirmationLevel.WRITE, "解决长期知识冲突", id + " => " + decision)) {
            return AgentToolResult.error("用户未确认长期知识更新。", Map.of("requiresConfirmation", true, "conflictId", id));
        }
        try {
            KnowledgeGraph.Conflict resolved = context.knowledgeGraph().resolveConflict(id, decision.equals("accept"));
            context.saveProject();
            return AgentToolResult.ok("长期知识冲突已处理：" + resolved.status(), Map.of("conflict", resolved.toMap()));
        } catch (RuntimeException failure) {
            return AgentToolResult.error("无法处理长期知识冲突：" + failure.getMessage());
        }
    }

    private static String conflictDetail(List<KnowledgeGraph.Conflict> conflicts) {
        return conflicts.stream().limit(8).map(item -> item.conflictId() + " " + item.field() + ": "
                + item.currentValue() + " -> " + item.proposedValue() + " (" + item.currentSource() + " -> " + item.proposedSource() + ")")
                .reduce((a, b) -> a + "\n" + b).orElse("长期知识存在冲突");
    }

    private static String conversationText(AgentToolContext context) {
        StringBuilder out = new StringBuilder();
        for (Map<String, Object> message : context.conversationHistory()) {
            Object content = message.get("content");
            if (content != null && !String.valueOf(content).isBlank()) {
                out.append(message.getOrDefault("role", "unknown")).append(": ").append(content).append('\n');
            }
        }
        return out.toString().trim();
    }

    private static String canvasContext(AgentToolContext context) {
        WorkflowModel model = context.model();
        if (model == null || model.nodes().isEmpty()) return "";
        WorkflowDslService.Architecture architecture = new WorkflowDslService().decodeArchitecture(model);
        return architecture.markdown() + "\nAST=" + Json.stringify(architecture.ast());
    }

    private static Map<String, Object> schema(Map<String, Object> properties, List<String> required) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("type", "object"); result.put("properties", properties); result.put("required", required); return result;
    }
    private static Map<String, Object> string(String description) { return Map.of("type", "string", "description", description); }
    private static Map<String, Object> integer(String description) { return Map.of("type", "integer", "description", description); }
    private static Map<String, Object> bool(String description) { return Map.of("type", "boolean", "description", description); }
}
