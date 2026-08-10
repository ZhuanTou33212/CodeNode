package local.codenode.config;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;

/**
 * 内嵌 Agent 的本地配置文件（默认 {@code config/agent.properties}，启动自动生成）。
 * 仅存 baseUrl / apiKey / model / default_project_path，apiKey 不入库、不写入 .cnode、不随日志输出。
 */
public final class AgentConfig {
    public static final String CONFIG_DIR = "config";
    public static final String CONFIG_FILE = "agent.properties";
    public static final String DEFAULT_MODEL = "deepseek-v4-flash";
    /** 默认可用模型列表（本端点两个模型：deepseek-v4-flash=ds chat，deepseek-v4-pro=ds pro）。 */
    public static final List<String> DEFAULT_MODELS = List.of("deepseek-v4-flash", "deepseek-v4-pro");

    private final Path file;
    private final Properties properties = new Properties();

    public AgentConfig() {
        this(Path.of(System.getProperty("user.dir", "."), CONFIG_DIR, CONFIG_FILE));
    }

    public AgentConfig(Path file) {
        this.file = file == null ? Path.of(CONFIG_DIR, CONFIG_FILE) : file;
    }

    public static AgentConfig load() {
        AgentConfig config = new AgentConfig();
        config.reload();
        return config;
    }

    /** 从磁盘重新加载；文件不存在时保持默认（并触发 createDefaultsIfMissing）。 */
    public synchronized void reload() {
        properties.clear();
        if (Files.isRegularFile(file)) {
            try (var reader = new InputStreamReader(Files.newInputStream(file), StandardCharsets.UTF_8)) {
                properties.load(reader);
            } catch (IOException ignored) {}
        }
    }

    /** 启动时调用：确保配置文件存在，否则用默认值生成。 */
    public synchronized void createDefaultsIfMissing() throws IOException {
        if (!Files.isRegularFile(file)) {
            save();
        }
    }

    /** 写入配置文件（UTF-8）。 */
    public synchronized void save() throws IOException {
        if (file.getParent() != null) Files.createDirectories(file.getParent());
        if (!Files.exists(file)) Files.createFile(file);
        try (var writer = new OutputStreamWriter(Files.newOutputStream(file), StandardCharsets.UTF_8)) {
            properties.store(writer, "CodeNode Agent configuration (本地文件，不随工程提交)");
        }
    }

    public Path file() { return file; }

    public String apiBase() { return properties.getProperty("api_base", ""); }
    public String apiKey() { return properties.getProperty("api_key", ""); }
    public String model() { return properties.getProperty("model", DEFAULT_MODEL); }
    public String defaultProjectPath() { return properties.getProperty("default_project_path", ""); }

    /** 可切换的模型列表（配置文件 models 字段，逗号分隔；缺省用 DEFAULT_MODELS）。 */
    public List<String> models() {
        String value = properties.getProperty("models", "");
        if (value.isBlank()) return DEFAULT_MODELS;
        return Arrays.stream(value.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    public boolean isConfigured() {
        return !apiBase().isBlank() && !apiKey().isBlank();
    }

    // ---------- harness 与工具设置（Stage6） ----------

    /** 禁用的工具名列表（逗号分隔；空=全部启用）。禁用优先级高于 {@link #enabledTools()}。 */
    public List<String> disabledTools() {
        return parseList(properties.getProperty("tools.disabled", ""));
    }

    /** 仅启用的工具名列表（逗号分隔；空=不限制）。 */
    public List<String> enabledTools() {
        return parseList(properties.getProperty("tools.enabled", ""));
    }

    /** 追加到系统提示末尾的自定义提示（多行可用 \n 转义）。 */
    public String extraHarnessPrompt() {
        String value = properties.getProperty("harness.extra_prompt", "");
        return value.replace("\\n", "\n").trim();
    }

    /** read_file 默认最大行数。 */
    public int readFileMaxLines() {
        return parseInt(properties.getProperty("read_file.max_lines", "200"), 200);
    }

    /** analyze 模式默认分析行数上限。 */
    public int fileAnalysisMaxLines() {
        return parseInt(properties.getProperty("file_analysis.max_lines", "200"), 200);
    }


    public String permission(String category) {
        String value = properties.getProperty("agent.permissions", "ui:allow,write:confirm,execute:confirm,system:enabled");
        for (String item : value.split(",")) { String[] pair = item.trim().split(":", 2); if (pair.length == 2 && pair[0].trim().equalsIgnoreCase(category)) return pair[1].trim().toLowerCase(); }
        return "confirm";
    }
    public boolean isPermissionAllowed(String category) { return "allow".equals(permission(category)) || "enabled".equals(permission(category)); }
    public boolean isSystemEnabled() { return isPermissionAllowed("system"); }
    public String permissions() { return properties.getProperty("agent.permissions", "ui:allow,write:confirm,execute:confirm,system:enabled"); }
    public void setPermissions(String value) { properties.setProperty("agent.permissions", value == null || value.isBlank() ? "ui:allow,write:confirm,execute:confirm,system:enabled" : value.trim()); }

    /** 工具是否允许注册：不在 disabled 且（enabled 为空或在 enabled 内）。 */
    public boolean isToolAllowed(String toolName) {
        if (toolName == null || toolName.isBlank()) return false;
        if (disabledTools().contains(toolName)) return false;
        List<String> enabled = enabledTools();
        return enabled.isEmpty() || enabled.contains(toolName);
    }

    private static List<String> parseList(String value) {
        if (value == null || value.isBlank()) return List.of();
        return Arrays.stream(value.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value.trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    public void setApiBase(String value) { properties.setProperty("api_base", value == null ? "" : value.trim()); }
    public void setApiKey(String value) { properties.setProperty("api_key", value == null ? "" : value.trim()); }
    public void setModel(String value) { properties.setProperty("model", value == null || value.isBlank() ? DEFAULT_MODEL : value.trim()); }
    public void setModels(List<String> models) { properties.setProperty("models", models == null || models.isEmpty() ? "" : String.join(",", models)); }
    public void setDefaultProjectPath(String value) { properties.setProperty("default_project_path", value == null ? "" : value.trim()); }
}
