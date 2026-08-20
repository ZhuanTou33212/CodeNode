package local.codenode.agent.components;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 非持久化会话存储，适合临时/最小 harness 配置与测试。 */
public final class MemorySessionStore implements SessionStore {

    private final Map<String, Snapshot> sessions = new LinkedHashMap<>();

    @Override
    public synchronized void save(Path projectRoot, String sessionId, String summary, List<Map<String, Object>> messages) {
        sessions.put(key(projectRoot, sessionId), new Snapshot(summary, messages));
    }

    @Override
    public synchronized Snapshot load(Path projectRoot, String sessionId) {
        return sessions.getOrDefault(key(projectRoot, sessionId), new Snapshot("", List.of()));
    }

    @Override
    public synchronized void delete(Path projectRoot, String sessionId) {
        sessions.remove(key(projectRoot, sessionId));
    }

    private static String key(Path root, String sessionId) {
        return String.valueOf(root) + "\n" + sessionId;
    }
}
