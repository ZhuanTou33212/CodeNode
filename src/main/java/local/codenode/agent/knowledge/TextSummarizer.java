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
    private static final Set<String> STOP = Set.of(
            "the", "and", "for", "with", "that", "this", "from", "into", "then", "when",
            "一个", "一种", "这个", "那个", "以及", "进行", "实现", "使用", "可以", "需要", "其中", "如果", "通过");
    private static final Pattern WORD = Pattern.compile("[A-Za-z][A-Za-z0-9_$-]{2,}|[\\p{IsHan}]{2,8}");
    private static final Pattern ENTITY = Pattern.compile(
            "(?:class|interface|record|enum|def|function|package|import)\\s+([A-Za-z_$][\\w.$]*)");
    private static final Pattern REF = Pattern.compile(
            "(?:https?://\\S+|[A-Za-z0-9_./\\\\-]+\\.(?:java|kt|py|js|ts|md|json|yaml|yml|xml|properties))");

    public Summary summarize(String text) {
        String normalized = text == null ? "" : text.replace("\r", "").trim();
        if (normalized.isEmpty()) return new Summary("空文本", "", List.of(), List.of(), List.of());
        List<String> blocks = normalized.lines().map(String::trim).filter(s -> !s.isBlank()).toList();
        String title = blocks.stream().filter(s -> s.startsWith("#")).findFirst()
                .map(s -> s.replaceFirst("^#+\\s*", ""))
                .orElseGet(() -> abbreviate(blocks.getFirst(), 80));
        String summary = balancedSummary(blocks);

        Map<String, Integer> counts = new HashMap<>();
        Matcher words = WORD.matcher(normalized);
        while (words.find()) {
            for (String token : splitCamel(words.group())) {
                String key = token.toLowerCase(Locale.ROOT);
                if (key.length() >= 2 && !STOP.contains(key)) counts.merge(key, 1, Integer::sum);
            }
        }
        List<String> keywords = counts.entrySet().stream()
                .sorted((a, b) -> {
                    int byCount = Integer.compare(b.getValue(), a.getValue());
                    return byCount != 0 ? byCount : a.getKey().compareTo(b.getKey());
                })
                .limit(12).map(Map.Entry::getKey).toList();
        return new Summary(title, summary, keywords,
                List.copyOf(matches(ENTITY, normalized, 1, 16)),
                List.copyOf(matches(REF, normalized, 0, 16)));
    }

    private static String balancedSummary(List<String> blocks) {
        StringBuilder out = new StringBuilder();
        for (String block : blocks) {
            String clean = block.replaceFirst("^#+\\s*", "");
            if (out.length() > 0) out.append("；");
            out.append(abbreviate(clean, 180));
            if (out.length() >= 520) break;
        }
        return abbreviate(out.toString(), 600);
    }

    private static List<String> splitCamel(String value) {
        String spaced = value.replaceAll("([a-z0-9])([A-Z])", "$1 $2")
                .replace('_', ' ').replace('-', ' ');
        List<String> result = new ArrayList<>();
        for (String part : spaced.split("\\s+")) if (!part.isBlank()) result.add(part);
        return result;
    }

    private static LinkedHashSet<String> matches(Pattern pattern, String text, int group, int max) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        Matcher matcher = pattern.matcher(text);
        while (matcher.find() && result.size() < max) {
            result.add(matcher.group(group).replaceAll("[),.;]+$", ""));
        }
        return result;
    }

    private static String abbreviate(String value, int max) {
        String compact = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        return compact.length() <= max ? compact : compact.substring(0, max) + "…";
    }

    public record Summary(String title, String summary, List<String> keywords,
                          List<String> entities, List<String> refs) {}
}
