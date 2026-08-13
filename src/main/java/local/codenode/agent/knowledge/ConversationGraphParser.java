package local.codenode.agent.knowledge;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Converts long conversation text into a deterministic hierarchical graph without a network call. */
public final class ConversationGraphParser {
    private static final int MAX_CHUNK_CHARS = 2400;
    private final TextSummarizer summarizer = new TextSummarizer();

    public KnowledgeGraph parse(String text, String canvasContext, String sourceLocation) {
        String value = text == null ? "" : text.replace("\r", "").trim();
        if (value.isBlank()) throw new IllegalArgumentException("待解析文本不能为空");
        List<String> chunks = chunks(value);
        TextSummarizer.Summary whole = summarizer.summarize(value);
        String rootId = stableId("topic", whole.title(), value.hashCode());
        KnowledgeGraph graph = new KnowledgeGraph();
        List<String> rootKeywords = new ArrayList<>(whole.keywords());
        if (canvasContext != null && !canvasContext.isBlank()) rootKeywords.add("canvas");
        graph.put(new KnowledgeGraph.Element(rootId, whole.title(), whole.summary(), rootKeywords,
                sourceLocation == null ? "conversation" : sourceLocation, "", List.of()));
        graph.addRoot(rootId);
        for (int i = 0; i < chunks.size(); i++) {
            String chunk = chunks.get(i);
            TextSummarizer.Summary summary = summarizer.summarize(chunk);
            String id = stableId("part" + (i + 1), summary.title(),
                    (rootId + "\n" + sourceLocation + "\n" + chunk).hashCode());
            String location = (sourceLocation == null || sourceLocation.isBlank() ? "conversation" : sourceLocation)
                    + "#chunk=" + (i + 1);
            graph.put(new KnowledgeGraph.Element(id, summary.title(), summary.summary(),
                    summary.keywords(), location, "", List.of()));
            graph.connect(rootId, id);
        }
        if (canvasContext != null && !canvasContext.isBlank()) {
            TextSummarizer.Summary summary = summarizer.summarize(canvasContext);
            String id = stableId("canvas", summary.title(), canvasContext.hashCode());
            graph.put(new KnowledgeGraph.Element(id, "画布上下文", summary.summary(),
                    summary.keywords(), "canvas", "", List.of()));
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
            boolean boundary = !code && (line.isBlank() || line.matches("^#{1,6}\\s+.*")
                    || line.matches("^\\d+[.)、]\\s+.*"));
            if (boundary && current.length() > 0) flush(result, current);
            if (current.length() + line.length() + 1 > MAX_CHUNK_CHARS && current.length() > 0) flush(result, current);
            current.append(line).append('\n');
        }
        flush(result, current);
        return result;
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
}
