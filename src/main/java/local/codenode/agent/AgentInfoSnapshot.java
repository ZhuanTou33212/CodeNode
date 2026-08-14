package local.codenode.agent;

import local.codenode.Json;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** A bounded, deliberately allow-listed snapshot injected into the Agent harness. */
public final class AgentInfoSnapshot {
    public static final int MAX_CHARS = 256 * 1024;
    private static final String[] ALLOWED = {"version", "formatVersion", "mode", "language", "projectRoot", "projectName", "openDocuments", "currentDocument", "canvasNodes", "canvasEdges", "groups", "assetBundles", "selectedNodes", "selectedNodeId", "workbenchTab", "documentTab", "windowWidth", "windowHeight", "toolCount", "jdk", "gradle", "maven", "uiActions", "runConfig", "panelVisibility", "graphOverview", "graphRoots", "graphElements", "graphKeywords", "capturedAt"};
    private final Map<String, Object> values;

    public AgentInfoSnapshot(Map<String, ?> software, Map<String, ?> environment) {
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        copyAllowed(out, software); copyAllowed(out, environment);
        out.putIfAbsent("capturedAt", Instant.now().toString());
        this.values = Map.copyOf(out);
    }
    public static AgentInfoSnapshot capture(SoftwareInfoProvider provider) { return provider == null ? new AgentInfoSnapshot(Map.of(), Map.of()) : new AgentInfoSnapshot(provider.softwareInfo(), provider.environmentInfo()); }
    public Map<String, Object> values() { return values; }
    public String toText() {
        StringBuilder out = new StringBuilder("【软件信息】（动态快照）\n");
        for (var e : values.entrySet()) {
            String value = String.valueOf(e.getValue());
            if (value.length() > 2048) value = value.substring(0, 2048) + "…";
            out.append("- ").append(e.getKey()).append(": ").append(value).append('\n');
        }
        return out.length() > MAX_CHARS ? out.substring(0, MAX_CHARS) + "…" : out.toString();
    }
    public byte[] toJsonBytes() {
        LinkedHashMap<String, Object> document = new LinkedHashMap<>();
        document.put("schemaVersion", 1);
        document.put("generator", "CodeNode Desktop " + values.getOrDefault("version", "unknown"));
        document.putAll(values);
        byte[] encoded = Json.stringify(document).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (encoded.length <= MAX_CHARS) return encoded;
        LinkedHashMap<String, Object> bounded = new LinkedHashMap<>();
        bounded.put("schemaVersion", 1); bounded.put("generator", document.get("generator"));
        for (var entry : values.entrySet()) {
            String value = String.valueOf(entry.getValue());
            bounded.put(entry.getKey(), value.substring(0, Math.min(value.length(), 2048)));
        }
        return Json.stringify(bounded).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }
    public static AgentInfoSnapshot fromJson(Map<String, Object> values) {
        Object schema = values.get("schemaVersion");
        if (!(schema instanceof Number number) || number.intValue() != 1) throw new IllegalArgumentException("不支持的 agent-info schemaVersion：" + schema);
        return new AgentInfoSnapshot(values, Map.of());
    }
    private static void copyAllowed(Map<String, Object> out, Map<String, ?> source) {
        if (source == null) return;
        for (String key : ALLOWED) {
            Object value = source.get(key); if (value == null) continue;
            String lower = key.toLowerCase(Locale.ROOT);
            if (lower.contains("key") || lower.contains("password") || lower.contains("secret") || lower.contains("base")) continue;
            if ("projectRoot".equals(key)) { try { value = String.valueOf(Path.of(String.valueOf(value)).getFileName()); } catch (Exception ignored) { value = "(project)"; } }
            out.put(key, value);
        }
    }
}
