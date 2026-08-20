package local.codenode.agent.components;

import local.codenode.config.AgentConfig;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** 会话持久化组件；实现可以是文件、内存、数据库或外部存储。 */
public interface SessionStore {

    void save(Path projectRoot, String sessionId, String summary, List<Map<String, Object>> messages);

    Snapshot load(Path projectRoot, String sessionId);

    void delete(Path projectRoot, String sessionId);

    record Snapshot(String summary, List<Map<String, Object>> messages) {
        public Snapshot {
            summary = summary == null ? "" : summary;
            messages = messages == null ? List.of() : List.copyOf(messages);
        }
    }

    @FunctionalInterface
    interface Factory {
        SessionStore create(AgentConfig config, local.codenode.agent.tools.AgentToolContext toolContext);
    }
}
