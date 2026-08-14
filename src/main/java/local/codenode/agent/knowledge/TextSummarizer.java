package local.codenode.agent.knowledge;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Deterministic offline text summarization used before knowledge is persisted. */
public final class TextSummarizer {
    private static final Set<String> STOP = Set.of("the", "and", "for", "with", "that", "this", "from", "into", "then", "when",
            "a", "an", "of", "to", "in", "on", "is", "are", "or", "not",
            "\u4e00\u4e2a", "\u4e00\u79cd", "\u8fd9\u4e2a", "\u90a3\u4e2a", "\u4ee5\u53ca", "\u8fdb\u884c", "\u5b9e\u73b0", "\u4f7f\u7528", "\u53ef\u4ee5", "\u9700\u8981", "\u5176\u4e2d", "\u5982\u679c", "\u901a\u8fc7");
    private static final Pattern WORD = Pattern.compile("[A-Za-z][A-Za-z0-9_$-]{2,}|[\\p{IsHan}]{2,8}");
    private static final Pattern ENTITY = Pattern.compile("(?:class|interface|record|enum|def|function|package|import)\\s+([A-Za-z_$][\\w.$]*)");
    private static final Pattern REF = Pattern.compile("(?:https?://\\S+|[A-Za-z0-9_./\\\\-]+\\.(?:java|kt|py|js|ts|md|json|yaml|yml|xml|properties))");

    public enum Level { NONE, MINIMAL, BALANCED, VERBOSE }

    public Summary summarize(String text) { return summarize(text, Level.BALANCED); }

    public Summary summarize(String text, Level level) {
        String normalized = text == null ? "" : text.replace("\r", "").trim();
        if (normalized.isEmpty()) return new Summary("Empty text", "", List.of(), List.of(), List.of());
        Level effective = level == null ? Level.BALANCED : level;
        List<String> blocks = normalized.lines().map(String::trim).filter(s -> !s.isBlank()).toList();
        String title = blocks.stream().filter(s -> s.startsWith("#")).findFirst()
                .map(s -> s.replaceFirst("^#+\\s*", ""))
                .orElseGet(() -> abbreviate(blocks.getFirst(), 80));
        Map<String, Integer> counts = wordCounts(normalized);
        int keywordLimit = switch (effective) { case NONE -> 0; case MINIMAL -> 6; case BALANCED -> 12; case VERBOSE -> 20; };
        int entityLimit = switch (effective) { case NONE -> 0; case MINIMAL -> 4; case BALANCED -> 16; case VERBOSE -> 32; };
        int summaryLimit = switch (effective) { case NONE -> 0; case MINIMAL -> 180; case BALANCED -> 600; case VERBOSE -> 1800; };
        String summary = summaryLimit == 0 ? "" : summarizeBlocks(blocks, summaryLimit);
        return new Summary(title, summary, topKeywords(counts, keywordLimit),
                List.copyOf(matches(ENTITY, normalized, 1, entityLimit)),
                List.copyOf(matches(REF, normalized, 0, entityLimit)));
    }

    private static Map<String, Integer> wordCounts(String text) {
        Map<String, Integer> counts = new HashMap<>();
        Matcher words = WORD.matcher(text);
        while (words.find()) for (String token : splitCamel(words.group())) {
            String key = token.toLowerCase(Locale.ROOT);
            if (key.length() >= 2 && !STOP.contains(key)) counts.merge(key, 1, Integer::sum);
        }
        return counts;
    }

    private static List<String> topKeywords(Map<String, Integer> counts, int limit) {
        if (limit <= 0) return List.of();
        return counts.entrySet().stream().sorted((a, b) -> {
            int byCount = Integer.compare(b.getValue(), a.getValue());
            return byCount != 0 ? byCount : a.getKey().compareTo(b.getKey());
        }).limit(limit).map(Map.Entry::getKey).toList();
    }

    private static String summarizeBlocks(List<String> blocks, int max) {
        StringBuilder out = new StringBuilder();
        for (String block : blocks) {
            String clean = block.replaceFirst("^#+\\s*", "");
            if (out.length() > 0) out.append("; ");
            out.append(abbreviate(clean, Math.min(180, max)));
            if (out.length() >= max - 20) break;
        }
        return abbreviate(out.toString(), max);
    }

    private static List<String> splitCamel(String value) {
        String spaced = value.replaceAll("([a-z0-9])([A-Z])", "$1 $2").replace('_', ' ').replace('-', ' ');
        List<String> result = new ArrayList<>();
        for (String part : spaced.split("\\s+")) if (!part.isBlank()) result.add(part);
        return result;
    }

    private static LinkedHashSet<String> matches(Pattern pattern, String text, int group, int max) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        if (max <= 0) return result;
        Matcher matcher = pattern.matcher(text);
        while (matcher.find() && result.size() < max) result.add(matcher.group(group).replaceAll("[),.;]+$", ""));
        return result;
    }

    private static String abbreviate(String value, int max) {
        String compact = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        return compact.length() <= max ? compact : compact.substring(0, Math.max(0, max - 1)) + "…";
    }

    public record Summary(String title, String summary, List<String> keywords, List<String> entities, List<String> refs) {}
}
