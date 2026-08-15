package local.codenode.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * 跨项目的用户级长期记忆（{@code ~/.codenode/user-memory.md}）。
 *
 * <p>与项目级 {@link MemoryStore} 不同，用户记忆不绑定项目，注入所有项目
 * 的 agent 系统提示；保存为追加式（每次 save 追加一段，读取时截断到上限），
 * 由 {@code user_memory_save} 工具写入。home 可注入，便于测试隔离。</p>
 */
public final class UserMemoryStore {

    public static final int MAX_CHARS = 4000;

    private final Path home;

    public UserMemoryStore() {
        this(Path.of(System.getProperty("user.home", ".")));
    }

    public UserMemoryStore(Path home) {
        this.home = home == null ? Path.of(".") : home;
    }

    public Path file() {
        return home.resolve(".codenode").resolve("user-memory.md");
    }

    /** 读取用户记忆全文（截断到上限）；文件不存在或读取失败返回空串。 */
    public synchronized String read() {
        try {
            String text = Files.readString(file(), StandardCharsets.UTF_8).trim();
            if (text.length() > MAX_CHARS) text = text.substring(text.length() - MAX_CHARS);
            return text;
        } catch (IOException ignored) {
            return "";
        }
    }

    /** 追加一段用户记忆并返回文件路径；内容为空时不写入。 */
    public synchronized Path save(String content) throws IOException {
        String block = content == null ? "" : content.trim();
        if (block.isBlank()) throw new IllegalArgumentException("用户记忆内容不能为空");
        Path target = file();
        Files.createDirectories(target.getParent());
        String existing = read();
        String combined = existing.isBlank() ? block : existing + "\n\n---\n\n" + block;
        if (combined.length() > MAX_CHARS) combined = combined.substring(combined.length() - MAX_CHARS);
        Files.writeString(target, combined, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        return target;
    }
}
