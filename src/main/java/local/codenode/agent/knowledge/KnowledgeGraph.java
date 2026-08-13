package local.codenode.agent.knowledge;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Project-scoped hierarchical knowledge graph with a stable local DSL. */
public final class KnowledgeGraph {
    private final LinkedHashMap<String, Element> elements = new LinkedHashMap<>();
    private final LinkedHashSet<String> roots = new LinkedHashSet<>();

    public synchronized void clear() { elements.clear(); roots.clear(); }
    public synchronized boolean isEmpty() { return elements.isEmpty(); }
    public synchronized int size() { return elements.size(); }
    public synchronized List<String> roots() { return List.copyOf(roots); }
    public synchronized Element get(String id) { return elements.get(id); }
    public synchronized Collection<Element> elements() { return List.copyOf(elements.values()); }

    public synchronized void put(Element element) {
        if (element == null || element.id().isBlank()) throw new IllegalArgumentException("知识元素 id 不能为空");
        elements.put(element.id(), element.normalized());
    }

    public synchronized void addRoot(String id) {
        Element element = required(id);
        if (element.parent().isBlank()) roots.add(id);
    }

    public synchronized void connect(String parentId, String childId) {
        if (parentId.equals(childId)) throw new IllegalArgumentException("知识图谱不能自连接：" + parentId);
        Element parent = required(parentId);
        Element child = required(childId);
        if (isReachable(childId, parentId)) throw new IllegalArgumentException("知识图谱检测到循环：" + parentId + " -> " + childId);
        if (!child.parent().isBlank() && !child.parent().equals(parentId)) {
            throw new IllegalArgumentException("元素只能有一个直接父元素：" + childId);
        }
        LinkedHashSet<String> children = new LinkedHashSet<>(parent.children());
        children.add(childId);
        elements.put(parentId, parent.withChildren(List.copyOf(children)));
        elements.put(childId, child.withParent(parentId));
        roots.remove(childId);
    }

    public synchronized void merge(KnowledgeGraph fragment) {
        for (Element element : fragment.elements()) {
            Element previous = elements.get(element.id());
            put(previous == null ? element.withParent("").withChildren(List.of())
                    : previous.mergeMetadata(element));
        }
        for (Element element : fragment.elements()) {
            for (String child : element.children()) connect(element.id(), child);
        }
        for (String root : fragment.roots()) addRoot(root);
    }

    public synchronized List<Element> query(String query, Integer layer) {
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        Map<String, Integer> layers = layerIndexById();
        return elements.values().stream()
                .filter(e -> layer == null || layer < 0 || layers.getOrDefault(e.id(), -1) == layer)
                .filter(e -> needle.isBlank() || searchable(e).contains(needle))
                .sorted(Comparator.comparingInt((Element e) -> score(e, needle)).reversed()
                        .thenComparing(Element::id))
                .limit(50).toList();
    }

    public synchronized List<Element> traverse(String rootId, int depth) {
        required(rootId);
        int max = Math.max(0, Math.min(depth, 20));
        ArrayList<Element> result = new ArrayList<>();
        ArrayDeque<NodeDepth> queue = new ArrayDeque<>();
        queue.add(new NodeDepth(rootId, 0));
        while (!queue.isEmpty()) {
            NodeDepth current = queue.removeFirst();
            Element element = required(current.id());
            result.add(element);
            if (current.depth() < max) {
                for (String child : element.children()) queue.addLast(new NodeDepth(child, current.depth() + 1));
            }
        }
        return result;
    }

    public synchronized String toDsl() {
        StringBuilder out = new StringBuilder("# CodeNode knowledge graph v1\n");
        out.append("roots: ").append(String.join(",", roots)).append("\n");
        for (Element element : elements.values()) {
            if (!element.children().isEmpty()) {
                out.append(element.id()).append('(').append(String.join(",", element.children())).append(")\n");
            }
        }
        for (Element element : elements.values()) {
            out.append(element.id()).append(".summary: ").append(oneLine(element.summary())).append("\n");
            if (!element.keywords().isEmpty()) {
                out.append(element.id()).append(".keywords: ").append(String.join(",", element.keywords())).append("\n");
            }
            if (!element.location().isBlank()) {
                out.append(element.id()).append(".location: ").append(oneLine(element.location())).append("\n");
            }
            if (!element.title().isBlank()) {
                out.append(element.id()).append(".title: ").append(oneLine(element.title())).append("\n");
            }
        }
        return out.toString();
    }

    public static KnowledgeGraph parse(String dsl) {
        KnowledgeGraph graph = new KnowledgeGraph();
        if (dsl == null || dsl.isBlank()) return graph;
        List<String[]> edges = new ArrayList<>();
        List<String> declaredRoots = new ArrayList<>();
        for (String raw : dsl.replace("\r", "").split("\n")) {
            String line = raw.trim();
            if (line.isBlank() || line.startsWith("#")) continue;
            if (line.startsWith("roots:")) {
                for (String id : line.substring(6).split(",")) if (!id.trim().isBlank()) declaredRoots.add(id.trim());
                continue;
            }
            int dot = line.indexOf('.'), colon = line.indexOf(':');
            if (dot > 0 && colon > dot) {
                String id = line.substring(0, dot).trim();
                String field = line.substring(dot + 1, colon).trim();
                String value = line.substring(colon + 1).trim();
                Element element = graph.ensure(id);
                graph.elements.put(id, switch (field) {
                    case "summary" -> element.withSummary(value);
                    case "keywords" -> element.withKeywords(csv(value));
                    case "location" -> element.withLocation(value);
                    case "title" -> element.withTitle(value);
                    default -> element;
                });
                continue;
            }
            int open = line.indexOf('('), close = line.lastIndexOf(')');
            if (open > 0 && close > open) {
                String parent = line.substring(0, open).trim();
                graph.ensure(parent);
                for (String child : line.substring(open + 1, close).split(",")) {
                    if (!child.trim().isBlank()) {
                        graph.ensure(child.trim());
                        edges.add(new String[]{parent, child.trim()});
                    }
                }
            }
        }
        for (String[] edge : edges) graph.connect(edge[0], edge[1]);
        if (declaredRoots.isEmpty()) {
            for (Element element : graph.elements.values()) {
                if (element.parent().isBlank()) graph.roots.add(element.id());
            }
        } else {
            for (String root : declaredRoots) {
                graph.ensure(root);
                graph.addRoot(root);
            }
        }
        return graph;
    }

    public synchronized Map<String, Object> toMap() {
        Map<String, Integer> layers = layerIndexById();
        LinkedHashMap<String, List<String>> layerIndex = new LinkedHashMap<>();
        LinkedHashMap<String, List<String>> keywordIndex = new LinkedHashMap<>();
        for (Element element : elements.values()) {
            layerIndex.computeIfAbsent(String.valueOf(layers.getOrDefault(element.id(), -1)), k -> new ArrayList<>()).add(element.id());
            for (String keyword : element.keywords()) {
                keywordIndex.computeIfAbsent(keyword.toLowerCase(Locale.ROOT), k -> new ArrayList<>()).add(element.id());
            }
        }
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("schemaVersion", 1);
        out.put("roots", List.copyOf(roots));
        out.put("elements", elements.values().stream().map(Element::toMap).toList());
        out.put("layerIndex", layerIndex);
        out.put("keywordIndex", keywordIndex);
        return out;
    }

    public synchronized String overview() {
        String summaries = roots.stream().map(elements::get)
                .filter(e -> e != null && !e.summary().isBlank()).limit(5)
                .map(e -> e.id() + ":" + e.summary()).reduce((a, b) -> a + " | " + b).orElse("");
        return "知识图谱：" + size() + " 个元素；根元素=" + String.join(",", roots)
                + (summaries.isBlank() ? "" : "；顶层摘要=" + summaries);
    }

    private Element ensure(String id) {
        return elements.computeIfAbsent(id, key -> new Element(key, key, "", List.of(), "", "", List.of()));
    }
    private Element required(String id) {
        Element element = elements.get(id);
        if (element == null) throw new IllegalArgumentException("知识元素不存在：" + id);
        return element;
    }
    private boolean isReachable(String from, String target) {
        if (!elements.containsKey(from)) return false;
        ArrayDeque<String> queue = new ArrayDeque<>();
        LinkedHashSet<String> visited = new LinkedHashSet<>();
        queue.add(from);
        while (!queue.isEmpty()) {
            String id = queue.removeFirst();
            if (!visited.add(id)) continue;
            if (id.equals(target)) return true;
            Element element = elements.get(id);
            if (element != null) queue.addAll(element.children());
        }
        return false;
    }
    private Map<String, Integer> layerIndexById() {
        LinkedHashMap<String, Integer> out = new LinkedHashMap<>();
        ArrayDeque<NodeDepth> queue = new ArrayDeque<>();
        for (String root : roots) queue.add(new NodeDepth(root, 0));
        while (!queue.isEmpty()) {
            NodeDepth current = queue.removeFirst();
            if (out.putIfAbsent(current.id(), current.depth()) != null) continue;
            Element element = elements.get(current.id());
            if (element != null) for (String child : element.children()) queue.addLast(new NodeDepth(child, current.depth() + 1));
        }
        return out;
    }
    private static int score(Element e, String needle) {
        if (needle.isBlank()) return 0;
        if (e.id().equalsIgnoreCase(needle)) return 100;
        if (e.keywords().stream().anyMatch(k -> k.equalsIgnoreCase(needle))) return 80;
        if (e.title().toLowerCase(Locale.ROOT).contains(needle)) return 60;
        return 20;
    }
    private static String searchable(Element e) {
        return (e.id() + " " + e.title() + " " + e.summary() + " "
                + String.join(" ", e.keywords()) + " " + e.location()).toLowerCase(Locale.ROOT);
    }
    private static List<String> csv(String value) {
        return java.util.Arrays.stream(value.split(",")).map(String::trim).filter(s -> !s.isBlank()).distinct().toList();
    }
    private static String oneLine(String value) {
        return value == null ? "" : value.replace("\r", " ").replace("\n", " ").trim();
    }
    private record NodeDepth(String id, int depth) {}

    public record Element(String id, String title, String summary, List<String> keywords,
                          String location, String parent, List<String> children) {
        public Element {
            id = id == null ? "" : id.trim(); title = title == null ? "" : title;
            summary = summary == null ? "" : summary;
            keywords = keywords == null ? List.of() : List.copyOf(new LinkedHashSet<>(keywords));
            location = location == null ? "" : location; parent = parent == null ? "" : parent;
            children = children == null ? List.of() : List.copyOf(new LinkedHashSet<>(children));
        }
        Element normalized() { return new Element(id, title, summary, keywords, location, parent, children); }
        Element withChildren(List<String> v) { return new Element(id, title, summary, keywords, location, parent, v); }
        Element withParent(String v) { return new Element(id, title, summary, keywords, location, v, children); }
        Element withSummary(String v) { return new Element(id, title, v, keywords, location, parent, children); }
        Element withKeywords(List<String> v) { return new Element(id, title, summary, v, location, parent, children); }
        Element withLocation(String v) { return new Element(id, title, summary, keywords, v, parent, children); }
        Element withTitle(String v) { return new Element(id, v, summary, keywords, location, parent, children); }
        Element mergeMetadata(Element other) {
            return new Element(id, other.title.isBlank() ? title : other.title,
                    other.summary.isBlank() ? summary : other.summary,
                    other.keywords.isEmpty() ? keywords : other.keywords,
                    other.location.isBlank() ? location : other.location, parent, children);
        }
        public Map<String, Object> toMap() {
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            out.put("id", id); out.put("title", title); out.put("summary", summary);
            out.put("keywords", keywords); out.put("location", location);
            out.put("parent", parent); out.put("children", children); return out;
        }
    }
}
