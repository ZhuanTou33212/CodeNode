package local.codenode;

import local.codenode.agent.UserMemoryStore;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.impl.AgentToolkit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P4 全局用户记忆：UserMemoryStore 追加式读写 + user_memory_save 工具注册与执行。
 */
class UserMemoryTest {
    @TempDir
    Path home;

    private AgentToolContext context(Path root) {
        return new AgentToolContext(() -> root, () -> null, (level, what, detail) -> true, entry -> {});
    }

    @Test
    void storeAppendsAndTruncates() throws Exception {
        UserMemoryStore store = new UserMemoryStore(home);
        assertFalse(Files.exists(store.file()), "初始无文件");
        assertEquals("", store.read());
        store.save("第一条偏好");
        store.save("第二条偏好");
        String text = store.read();
        assertTrue(text.contains("第一条偏好") && text.contains("第二条偏好"), "追加式保存: " + text);
        assertEquals("第一条偏好\n\n---\n\n第二条偏好", text.trim());
    }

    @Test
    void storeCapsLength() throws Exception {
        UserMemoryStore store = new UserMemoryStore(home);
        String big = "x".repeat(UserMemoryStore.MAX_CHARS + 500);
        store.save(big);
        assertEquals(UserMemoryStore.MAX_CHARS, store.read().length(), "读取应截断到上限");
    }

    @Test
    void toolIsRegisteredAndExecutes() throws Exception {
        System.setProperty("codenode.user.home", home.toString());
        try {
            Path root = home.resolve("project");
            Files.createDirectories(root);
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context(root));
            assertTrue(registry.contains("user_memory_save"), "user_memory_save 应注册");
            AgentToolResult result = registry.execute("user_memory_save",
                    java.util.Map.of("content", "用户偏好使用中文回复"), context(root));
            assertTrue(result.ok(), "保存应成功: " + result.text());
            Path file = home.resolve(".codenode").resolve("user-memory.md");
            assertTrue(Files.isRegularFile(file), "应写入 ~/.codenode/user-memory.md");
            String saved = Files.readString(file, StandardCharsets.UTF_8);
            assertTrue(saved.contains("用户偏好使用中文回复"));
        } finally {
            System.clearProperty("codenode.user.home");
        }
    }

    @Test
    void toolRejectsBlankContent() throws Exception {
        Path root = home.resolve("project");
        Files.createDirectories(root);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context(root));
        AgentToolResult result = registry.execute("user_memory_save", java.util.Map.of("content", "  "), context(root));
        assertFalse(result.ok(), "空内容应被拒绝");
    }
}
