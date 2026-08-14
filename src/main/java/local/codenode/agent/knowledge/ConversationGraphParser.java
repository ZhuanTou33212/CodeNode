package local.codenode.agent.knowledge;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Converts long conversation text into a deterministic hierarchical graph without a network call. */
public final class ConversationGraphParser {
    private static final int MAX_CHUNK_CHARS = 2400;
    private static final Pattern HEADING = Pattern.compile("^(#{1,6})\\s+.*");
    private static final Pattern NUMBERED = Pattern.compile("^(\\d+(?:\\.\\d+)*)(?:[.)、])\\s+.*");
    private final TextSummarizer summarizer = new TextSummarizer();

    public KnowledgeGraph parse(String text, String canvasContext, String sourceLocation) {
        String value = text == null ? "" : text.replace("\r", "").trim();
        if (value.isBlank()) throw new IllegalArgumentException("conversation text must not be blank");
        List<String> chunks = chunks(value);
        TextSummarizer.Summary whole = summarizer.summarize(value);
        String rootId = stableId("topic", whole.title(), value.hashCode());
        KnowledgeGraph graph = new KnowledgeGraph();
        String source = sourceLocation == null || sourceLocation.isBlank() ? "conversation" : sourceLocation;
        Instant capturedAt = Instant.now();
        List<String> rootKeywords = new ArrayList<>(whole.keywords());
        if (canvasContext != null && !canvasContext.isBlank()) rootKeywords.add("canvas");
        graph.put(new KnowledgeGraph.Element(rootId, whole.title(), whole.summary(), rootKeywords,
                source, "", List.of(), source, capturedAt, "active"));
        graph.addRoot(rootId);
        Deque<SectionNode> hierarchy = new ArrayDeque<>();
        for (int i = 0; i < chunks.size(); i++) {
            String chunk = chunks.get(i);
            TextSummarizer.Summary summary = summarizer.summarize(chunk);
            String id = stableId("part" + (i + 1), summary.title(),
                    (rootId + "\n" + source + "\n" + chunk).hashCode());
            String location = source + "#chunk=" + (i + 1);
            graph.put(new KnowledgeGraph.Element(id, summary.title(), summary.summary(),
                    summary.keywords(), location, "", List.of(), source, capturedAt, "active"));
            int level = sectionLevel(chunk);
            while (!hierarchy.isEmpty() && hierarchy.peekLast().level >= level) hierarchy.removeLast();
            graph.connect(hierarchy.isEmpty() ? rootId : hierarchy.peekLast().id, id);
            if (level < Integer.MAX_VALUE) hierarchy.addLast(new SectionNode(id, level));
        }
        if (canvasContext != null && !canvasContext.isBlank()) {
            TextSummarizer.Summary summary = summarizer.summarize(canvasContext);
            String id = stableId("canvas", summary.title(), canvasContext.hashCode());
            graph.put(new KnowledgeGraph.Element(id, "Canvas context", summary.summary(),
                    summary.keywords(), "canvas", "", List.of(), "canvas", capturedAt, "active"));
            graph.connect(rootId, id);
        }
        return graph;
    }

    static List<String> chunks(String text) {
        ArrayList<String> result = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean code = false;
        for (String line : text.split("\n", -1)) {
            if (line.trim().startsWith("```")) code = !code;
            boolean boundary = !code && (line.isBlank() || HEADING.matcher(line).matches()
                    || NUMBERED.matcher(line).matches());
            if (boundary && current.length() > 0) flush(result, current);
            if (current.length() + line.length() + 1 > MAX_CHUNK_CHARS && current.length() > 0) flush(result, current);
            current.append(line).append('\n');
        }
        flush(result, current);
        return result;
    }

    private static int sectionLevel(String chunk) {
        String first = chunk.lines().map(String::trim).filter(s -> !s.isBlank()).findFirst().orElse("");
        Matcher heading = HEADING.matcher(first);
        if (heading.matches()) return heading.group(1).length();
        Matcher numbered = NUMBERED.matcher(first);
        if (numbered.matches()) return 10 + numbered.group(1).split("\\.").length;
        return Integer.MAX_VALUE;
    }

    private static void flush(List<String> result, StringBuilder current) {
        String value = current.toString().trim();
        if (!value.isBlank()) result.add(value);
        current.setLength(0);
    }

    private static String stableId(String prefix, String title, int hash) {
        String slug = (title == null ? "" : title).toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9\\p{IsHan}]+", "_").replaceAll("^_+|_+$", "");
        if (slug.length() > 28) slug = slug.substring(0, 28);
        return prefix + "_" + (slug.isBlank() ? "text" : slug) + "_" + Integer.toUnsignedString(hash, 36);
    }

    private record SectionNode(String id, int level) {}
}
