package local.codenode.agent;

import local.codenode.Json;
import local.codenode.agent.tools.AgentToolResult;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

public final class AgentResultStore {
    private static final int MAX_RESULTS = 128;
    private final LinkedHashMap<String, Stored> results = new LinkedHashMap<>(16, 0.75f, true);

    public synchronized String store(String tool, AgentToolResult result) {
        String id = "result_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        results.put(id, new Stored(tool == null ? "" : tool, result, result.toJson()));
        while (results.size() > MAX_RESULTS) {
            Iterator<String> iterator = results.keySet().iterator();
            iterator.next();
            iterator.remove();
        }
        return id;
    }

    public synchronized String modelPayload(String resultId, String tool, AgentToolResult result, int maxChars) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("resultId", resultId);
        payload.put("tool", tool);
        payload.put("ok", result.ok());
        payload.put("text", result.text() == null ? "" : result.text());
        payload.put("dataAvailable", !result.data().isEmpty());
        payload.put("dataKeys", result.data().keySet());
        payload.put("data", Map.of("deferred", true, "resultId", resultId, "hint", "Call read_tool_result to fetch data"));
        String json = Json.stringify(payload);
        if (json.length() <= maxChars) return json;
        int textBudget = Math.max(600, maxChars / 2);
        payload.put("text", truncate(result.text(), textBudget));
        return Json.stringify(payload);
    }

    public synchronized AgentToolResult read(String resultId, int offset, int maxChars) {
        Stored stored = results.get(resultId);
        if (stored == null) return AgentToolResult.error("Result expired or not found: " + resultId);
        String json = stored.json();
        int start = Math.max(0, Math.min(offset, json.length()));
        int length = Math.max(200, Math.min(maxChars, 6000));
        int end = Math.min(json.length(), start + length);
        return AgentToolResult.ok(json.substring(start, end), Map.of(
                "resultId", resultId,
                "tool", stored.tool(),
                "offset", start,
                "nextOffset", end,
                "totalChars", json.length(),
                "hasMore", end < json.length()));
    }

    private static String truncate(String text, int max) {
        if (text == null) return "";
        if (text.length() <= max) return text;
        return text.substring(0, Math.max(1, max - 3)) + "...";
    }

    private record Stored(String tool, AgentToolResult result, String json) {}
}