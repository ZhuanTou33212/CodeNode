package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** fetch_url：抓取指定 URL 的文本内容（仅 http/https），maxChars 截断。 */
public final class FetchUrlTool {

    private FetchUrlTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "fetch_url",
            "抓取指定 URL 的文本内容（仅 http/https）。maxChars 截断返回长度（默认 5000）。",
            Map.of("type", "object",
                "properties", Map.of(
                    "url", Map.of("type", "string", "description", "要抓取的 URL"),
                    "maxChars", Map.of("type", "integer", "description", "最多返回字符数，默认 5000")),
                "required", List.of("url")),
            FetchUrlTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String url = String.valueOf(arguments.getOrDefault("url", "")).trim();
        if (url.isEmpty()) return AgentToolResult.error("缺少 url");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            return AgentToolResult.error("仅支持 http/https");
        }
        int maxChars = arguments.get("maxChars") instanceof Number n ? Math.max(100, n.intValue()) : 5000;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setRequestProperty("User-Agent", "codenode-agent");
            connection.setInstanceFollowRedirects(true);
            int status = connection.getResponseCode();
            if (status != 200) return AgentToolResult.error("HTTP " + status);
            String content = readAll(connection.getInputStream());
            boolean truncated = content.length() > maxChars;
            String shown = truncated ? content.substring(0, maxChars) : content;
            return AgentToolResult.ok((truncated ? "（截断，共 " + content.length() + " 字符）\n" : "") + shown,
                Map.of("url", url, "chars", content.length(), "truncated", truncated));
        } catch (Exception e) {
            return AgentToolResult.error("抓取失败：" + e.getMessage());
        }
    }

    private static String readAll(InputStream input) throws Exception {
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) >= 0) out.append(buffer, 0, read);
        }
        return out.toString();
    }
}
