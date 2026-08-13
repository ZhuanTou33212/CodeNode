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
        registry.register("graph_query", "按元素 id、标题、摘要、关键词或定位查询当前项目知识图谱。返回结构化元素，不猜测调用参数。",
                schema(Map.of("query", string("检索词或元素 id"), "layer", integer("可选层级，0 为根层")), List.of("query")), GraphTools::query);
        registry.register("graph_traverse", "从指定知识元素向下遍历直接子层，返回可验证的分层结构。",
                schema(Map.of("rootId", string("起始元素 id"), "depth", integer("向下深度，默认 2，最大 20")), List.of("rootId")), GraphTools::traverse);
        registry.register("graph_path", "读取元素的真实定位（对话分块、文件位置或画布）。",
                schema(Map.of("elementId", string("元素 id")), List.of("elementId")), GraphTools::path);
        registry.register("graph_summarize", "把长文本按段落/标题/代码块在本地分块摘要，生成与画布 DSL 同语法的分层知识图谱并固化到当前项目。text 缺省时总结当前会话；includeCanvas=true 时附加当前画布架构。",
                schema(Map.of("text", string("要固化的长文本，可省略以使用当前会话"), "source", string("来源定位"), "includeCanvas", bool("是否附加画布上下文，默认 true")), List.of()), GraphTools::summarize);
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
        return AgentToolResult.ok("知识图谱命中 " + matches.size() + " 项",
                Map.of("query", query, "matches", matches));
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
        context.knowledgeGraph().merge(fragment);
        context.audit("graph_summarize chars=" + text.length() + " elements=" + fragment.size());
        context.saveProject();
        return AgentToolResult.ok("已本地摘要并固化 " + fragment.size() + " 个知识元素",
                Map.of("roots", fragment.roots(), "elements", fragment.elements().stream()
                        .map(KnowledgeGraph.Element::toMap).toList(), "dsl", fragment.toDsl()));
    }

    private static String conversationText(AgentToolContext context) {
        StringBuilder out = new StringBuilder();
        for (Map<String, Object> message : context.conversationHistory()) {
            String role = String.valueOf(message.getOrDefault("role", "unknown"));
            Object content = message.get("content");
            if (content != null && !String.valueOf(content).isBlank()) {
                out.append(role).append(": ").append(content).append('\n');
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
