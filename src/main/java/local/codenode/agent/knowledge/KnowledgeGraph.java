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
import java.util.Objects;
import java.time.Instant;

/** Project-scoped hierarchical knowledge graph with a stable local DSL. */
public final class KnowledgeGraph {
    private final LinkedHashMap<String, Element> elements = new LinkedHashMap<>();
    private final LinkedHashSet<String> roots = new LinkedHashSet<>();
    private final LinkedHashMap<String, Conflict> conflicts = new LinkedHashMap<>();

    public synchronized void clear() { elements.clear(); roots.clear(); conflicts.clear(); }
    public synchronized boolean isEmpty() { return elements.isEmpty(); }
    public synchronized int size() { return elements.size(); }
    public synchronized List<String> roots() { return List.copyOf(roots); }
    public synchronized Element get(String id) { return elements.get(id); }
    public synchronized Collection<Element> elements() { return List.copyOf(elements.values()); }
    public synchronized List<Conflict> conflicts() { return List.copyOf(conflicts.values()); }
    public synchronized List<Conflict> pendingConflicts() {
        return conflicts.values().stream().filter(item -> "pending".equals(item.status())).toList();
    }

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

    /**
     * Merges only when no metadata conflict is present. Conflicting fragments are
     * deliberately left untouched and exposed through {@link #pendingConflicts()}.
     */
    public synchronized void merge(KnowledgeGraph fragment) {
        Objects.requireNonNull(fragment, "fragment");
        List<Conflict> detected = detectConflicts(fragment);
        if (!detected.isEmpty()) {
            rememberConflicts(detected);
            return;
        }
        mergeApproved(fragment);
    }

    /** Returns deterministic conflicts without changing graph state. */
    public synchronized List<Conflict> detectConflicts(KnowledgeGraph fragment) {
        Objects.requireNonNull(fragment, "fragment");
        ArrayList<Conflict> detected = new ArrayList<>();
        for (Element incoming : fragment.elements()) {
            Element existing = matchingElement(incoming);
            if (existing == null) continue;
            compareField(detected, existing, incoming, "title", existing.title(), incoming.title());
            compareField(detected, existing, incoming, "summary", existing.summary(), incoming.summary());
            compareField(detected, existing, incoming, "location", existing.location(), incoming.location());
            String oldKeywords = encodeKeywords(existing.keywords());
            String newKeywords = encodeKeywords(incoming.keywords());
            compareField(detected, existing, incoming, "keywords", oldKeywords, newKeywords);
        }
        return List.copyOf(detected);
    }

    /** Scans a current user message as a proposal without persisting it. */
    public synchronized List<Conflict> detectTextConflicts(String text) {
        if (text == null || text.isBlank() || !looksLikeMemoryProposal(text)) return List.of();
        try {
            KnowledgeGraph proposal = new ConversationGraphParser().parse(text, "", "conversation:current");
            return detectConflicts(proposal);
        } catch (RuntimeException ignored) {
            return List.of();
        }
    }

    private static boolean looksLikeMemoryProposal(String text) {
        String value = text.toLowerCase(Locale.ROOT);
        return value.matches("(?s).*(记住|长期|更新|修改|改为|换成|使用|不再|现在|instead|use |no longer|remember).*" );
    }

    /** Records conflicts without changing the active facts. */
    public synchronized void recordConflicts(Collection<Conflict> detected) {
        rememberConflicts(detected == null ? List.of() : List.copyOf(detected));
    }

    /** Applies an explicitly confirmed fragment and marks its conflicts superseded. */
    public synchronized void mergeApproved(KnowledgeGraph fragment) {
        Objects.requireNonNull(fragment, "fragment");
        List<Conflict> detected = detectConflicts(fragment);
        for (Conflict item : detected) {
            Conflict prior = conflicts.get(item.conflictId());
            conflicts.put(item.conflictId(), item.withStatus("accepted"));
            if (prior != null && "rejected".equals(prior.status())) {
                conflicts.put(item.conflictId(), item.withStatus("accepted"));
            }
        }
        mergeInternal(fragment);
    }

    /** Resolves one persisted conflict without replaying the original conversation. */
    public synchronized Conflict resolveConflict(String conflictId, boolean accept) {
        Conflict item = conflicts.get(conflictId);
        if (item == null) throw new IllegalArgumentException("Unknown knowledge conflict: " + conflictId);
        if (!"pending".equals(item.status())) return item;
        Element existing = elements.get(item.elementId());
        if (accept && existing != null) {
            elements.put(existing.id(), existing.withField(item.field(), item.proposedValue(),
                    item.proposedSource(), item.proposedUpdatedAt()));
        }
        Conflict resolved = item.withStatus(accept ? "accepted" : "rejected");
        conflicts.put(conflictId, resolved);
        return resolved;
    }

    private void rememberConflicts(Collection<Conflict> detected) {
        for (Conflict item : detected) conflicts.putIfAbsent(item.conflictId(), item);
    }

    private void mergeInternal(KnowledgeGraph fragment) {
        LinkedHashMap<String, String> remap = new LinkedHashMap<>();
        for (Element incoming : fragment.elements()) {
            Element existing = matchingElement(incoming);
            String targetId = existing == null ? incoming.id() : existing.id();
            remap.put(incoming.id(), targetId);
            if (existing == null) {
                put(incoming.withParent("").withChildren(List.of()));
            } else {
                elements.put(targetId, existing.mergeMetadata(incoming));
            }
        }
        for (Element incoming : fragment.elements()) {
            String parentId = remap.getOrDefault(incoming.id(), incoming.id());
            for (String child : incoming.children()) {
                String childId = remap.getOrDefault(child, child);
                if (!parentId.equals(childId)) {
                    Element childElement = elements.get(childId);
                    if (childElement != null && (childElement.parent().isBlank() || parentId.equals(childElement.parent()))) {
                        connect(parentId, childId);
                    }
                }
            }
        }
        for (String root : fragment.roots()) {
            String mapped = remap.getOrDefault(root, root);
            if (elements.containsKey(mapped) && elements.get(mapped).parent().isBlank()) roots.add(mapped);
        }
    }

    private Element matchingElement(Element incoming) {
        Element exact = elements.get(incoming.id());
        if (exact != null) return exact;
        String incomingTitle = normalize(incoming.title());
        String incomingSource = sourceRoot(incoming.location());
        for (Element candidate : elements.values()) {
            if (!incomingTitle.isBlank() && incomingTitle.equals(normalize(candidate.title()))) {
                boolean sameSource = !incomingSource.isBlank() && incomingSource.equals(sourceRoot(candidate.location()));
                boolean enoughKeywords = overlap(incoming.keywords(), candidate.keywords()) >= 2;
                if (sameSource || enoughKeywords) return candidate;
            }
        }
        return null;
    }

    private static int overlap(List<String> left, List<String> right) {
        if (left == null || right == null) return 0;
        java.util.HashSet<String> values = new java.util.HashSet<>(left);
        values.retainAll(right);
        return values.size();
    }

    private static void compareField(List<Conflict> out, Element existing, Element incoming,
                                     String field, String current, String proposed) {
        if (current == null || current.isBlank() || proposed == null || proposed.isBlank()
                || current.equals(proposed)) return;
        out.add(Conflict.create(existing.id(), incoming.id(), field, current, proposed,
                existing.source(), incoming.source(), existing.updatedAt(), incoming.updatedAt()));
    }

    private static String encodeKeywords(List<String> values) { return String.join("\u001f", values == null ? List.of() : values); }
    private static String normalize(String value) { return value == null ? "" : value.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]", "").trim(); }
    private static String sourceRoot(String value) {
        if (value == null || value.isBlank()) return "";
        int hash = value.indexOf('#');
        return (hash < 0 ? value : value.substring(0, hash)).trim().toLowerCase(Locale.ROOT);
    }

    /** Stable sidecar metadata persisted beside the human-readable DSL. */
    public synchronized Map<String, Object> toMetadataMap() {
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("format", "codenode-knowledge-meta");
        out.put("schemaVersion", 2);
        out.put("generatedAt", Instant.now().toString());
        out.put("elements", elements.values().stream().map(element -> Map.of(
                "id", element.id(), "source", element.source(),
                "updatedAt", element.updatedAt().toString(), "state", element.state())).toList());
        out.put("conflicts", conflicts.values().stream().map(Conflict::toMap).toList());
        out.put("elementCount", elements.size());
        out.put("roots", List.copyOf(roots));
        return out;
    }

    /** Applies optional sidecar metadata while keeping legacy DSL files readable. */
    public synchronized void applyMetadata(Map<String, Object> raw) {
        if (raw == null || raw.isEmpty()) return;
        Object version = raw.get("schemaVersion");
        if (version instanceof Number number && number.intValue() > 2) {
            throw new IllegalArgumentException("Unsupported knowledge metadata schemaVersion: " + version);
        }
        Object rawElements = raw.get("elements");
        if (rawElements instanceof List<?> list) {
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> map)) continue;
                String id = text(map.get("id"));
                Element existing = elements.get(id);
                if (existing == null) continue;
                Instant updated = instant(map.get("updatedAt"), existing.updatedAt());
                String source = text(map.get("source"));
                String state = text(map.get("state"));
                elements.put(id, new Element(existing.id(), existing.title(), existing.summary(), existing.keywords(),
                        existing.location(), existing.parent(), existing.children(),
                        source.isBlank() ? existing.source() : source,
                        updated, state.isBlank() ? existing.state() : state));
            }
        }
        Object rawConflicts = raw.get("conflicts");
        if (rawConflicts instanceof List<?> list) {
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> map)) continue;
                Conflict conflict = conflictFromMap(map);
                if (conflict != null) conflicts.put(conflict.conflictId(), conflict);
            }
        }
    }

    private static Conflict conflictFromMap(Map<?, ?> map) {
        String id = text(map.get("conflictId"));
        String elementId = text(map.get("elementId"));
        String field = text(map.get("field"));
        if (id.isBlank() || elementId.isBlank() || field.isBlank()) return null;
        return new Conflict(id, elementId, text(map.get("incomingElementId")), field,
                text(map.get("currentValue")), text(map.get("proposedValue")),
                text(map.get("currentSource")), text(map.get("proposedSource")),
                instant(map.get("currentUpdatedAt"), Instant.EPOCH),
                instant(map.get("proposedUpdatedAt"), Instant.EPOCH),
                instant(map.get("detectedAt"), Instant.EPOCH),
                text(map.get("status")).isBlank() ? "pending" : text(map.get("status")));
    }

    private static String text(Object value) { return value instanceof String string ? string : value == null ? "" : String.valueOf(value); }
    private static Instant instant(Object value, Instant fallback) {
        try { return value == null ? fallback : Instant.parse(String.valueOf(value)); }
        catch (RuntimeException ignored) { return fallback; }
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

    public record Conflict(String conflictId, String elementId, String incomingElementId, String field,
                           String currentValue, String proposedValue, String currentSource,
                           String proposedSource, Instant currentUpdatedAt, Instant proposedUpdatedAt,
                           Instant detectedAt, String status) {
        public static Conflict create(String elementId, String incomingElementId, String field,
                                      String currentValue, String proposedValue, String currentSource,
                                      String proposedSource, Instant currentUpdatedAt, Instant proposedUpdatedAt) {
            String key = elementId + "|" + field + "|" + proposedValue;
            String id = "conflict_" + Integer.toUnsignedString(key.hashCode(), 36);
            return new Conflict(id, elementId, incomingElementId, field, currentValue, proposedValue,
                    currentSource == null ? "" : currentSource, proposedSource == null ? "" : proposedSource,
                    currentUpdatedAt == null ? Instant.EPOCH : currentUpdatedAt,
                    proposedUpdatedAt == null ? Instant.now() : proposedUpdatedAt, Instant.now(), "pending");
        }
        public Conflict withStatus(String value) {
            return new Conflict(conflictId, elementId, incomingElementId, field, currentValue, proposedValue,
                    currentSource, proposedSource, currentUpdatedAt, proposedUpdatedAt, detectedAt, value);
        }
        public Map<String, Object> toMap() {
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            out.put("conflictId", conflictId); out.put("elementId", elementId);
            out.put("incomingElementId", incomingElementId); out.put("field", field);
            out.put("currentValue", currentValue); out.put("proposedValue", proposedValue);
            out.put("currentSource", currentSource); out.put("proposedSource", proposedSource);
            out.put("currentUpdatedAt", currentUpdatedAt.toString()); out.put("proposedUpdatedAt", proposedUpdatedAt.toString());
            out.put("detectedAt", detectedAt.toString()); out.put("status", status);
            return out;
        }
    }

    public record Element(String id, String title, String summary, List<String> keywords,
                          String location, String parent, List<String> children,
                          String source, Instant updatedAt, String state) {
        public Element(String id, String title, String summary, List<String> keywords,
                       String location, String parent, List<String> children) {
            this(id, title, summary, keywords, location, parent, children, location, Instant.now(), "active");
        }
        public Element {
            id = id == null ? "" : id.trim(); title = title == null ? "" : title;
            summary = summary == null ? "" : summary;
            keywords = keywords == null ? List.of() : List.copyOf(new LinkedHashSet<>(keywords));
            location = location == null ? "" : location; parent = parent == null ? "" : parent;
            children = children == null ? List.of() : List.copyOf(new LinkedHashSet<>(children));
            source = source == null ? "" : source;
            updatedAt = updatedAt == null ? Instant.now() : updatedAt;
            state = state == null || state.isBlank() ? "active" : state;
        }
        Element normalized() { return new Element(id, title, summary, keywords, location, parent, children, source, updatedAt, state); }
        Element withChildren(List<String> v) { return new Element(id, title, summary, keywords, location, parent, v, source, updatedAt, state); }
        Element withParent(String v) { return new Element(id, title, summary, keywords, location, v, children, source, updatedAt, state); }
        Element withSummary(String v) { return new Element(id, title, v, keywords, location, parent, children, source, Instant.now(), state); }
        Element withKeywords(List<String> v) { return new Element(id, title, summary, v, location, parent, children, source, Instant.now(), state); }
        Element withLocation(String v) { return new Element(id, title, summary, keywords, v, parent, children, source, Instant.now(), state); }
        Element withTitle(String v) { return new Element(id, v, summary, keywords, location, parent, children, source, Instant.now(), state); }
        Element withField(String field, String value, String newSource, Instant when) {
            List<String> values = "keywords".equals(field) && value != null && !value.isBlank()
                    ? List.of(value.split("\\u001f", -1)) : keywords;
            String nextTitle = "title".equals(field) ? value : title;
            String nextSummary = "summary".equals(field) ? value : summary;
            String nextLocation = "location".equals(field) ? value : location;
            List<String> nextKeywords = "keywords".equals(field) ? values : keywords;
            return new Element(id, nextTitle, nextSummary, nextKeywords, nextLocation, parent, children,
                    newSource, when == null ? Instant.now() : when, "active");
        }
        Element mergeMetadata(Element other) {
            return new Element(id, other.title.isBlank() ? title : other.title,
                    other.summary.isBlank() ? summary : other.summary,
                    other.keywords.isEmpty() ? keywords : other.keywords,
                    other.location.isBlank() ? location : other.location, parent, children,
                    other.source.isBlank() ? source : other.source,
                    other.updatedAt.isAfter(updatedAt) ? other.updatedAt : updatedAt, "active");
        }
        public Map<String, Object> toMap() {
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            out.put("id", id); out.put("title", title); out.put("summary", summary);
            out.put("keywords", keywords); out.put("location", location);
            out.put("parent", parent); out.put("children", children); out.put("source", source);
            out.put("updatedAt", updatedAt.toString()); out.put("state", state); return out;
        }
    }
}
