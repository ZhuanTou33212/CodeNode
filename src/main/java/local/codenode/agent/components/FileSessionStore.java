package local.codenode.agent.components;

import local.codenode.Json;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 默认文件会话存储，保持原有 .codenode/agent-sessions JSON 格式。 */
public final class FileSessionStore implements SessionStore {

    @Override
    public void save(Path projectRoot, String sessionId, String summary, List<Map<String, Object>> messages) {
        try {
            Path dir = projectRoot.resolve(".codenode/agent-sessions");
            Files.createDirectories(dir);
            LinkedHashMap<String, Object> record = new LinkedHashMap<>();
            record.put("sessionId", sessionId);
            record.put("summary", summary == null ? "" : summary);
            record.put("messages", messages == null ? List.of() : messages);
            Files.writeString(dir.resolve(sessionId + ".json"), Json.stringify(record),
                    StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                    StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException ignored) {
            // 持久化失败不阻断会话
        }
    }

    @Override
    public Snapshot load(Path projectRoot, String sessionId) {
        try {
            Path file = projectRoot.resolve(".codenode/agent-sessions").resolve(sessionId + ".json");
            if (!Files.isRegularFile(file)) return new Snapshot("", List.of());
            Map<String, Object> record = Json.object(Files.readString(file, StandardCharsets.UTF_8));
            String summary = record.get("summary") instanceof String value ? value : "";
            List<Map<String, Object>> messages = new java.util.ArrayList<>();
            if (record.get("messages") instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof Map<?, ?> map) messages.add(toStringMap(map));
                }
            }
            return new Snapshot(summary, messages);
        } catch (Exception ignored) {
            return new Snapshot("", List.of());
        }
    }

    @Override
    public void delete(Path projectRoot, String sessionId) {
        try {
            Files.deleteIfExists(projectRoot.resolve(".codenode/agent-sessions").resolve(sessionId + ".json"));
        } catch (IOException ignored) {
        }
    }

    private static Map<String, Object> toStringMap(Map<?, ?> map) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }
}
