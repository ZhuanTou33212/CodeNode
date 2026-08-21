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
import java.util.Optional;
import local.codenode.agent.components.HarnessAssembler;
import local.codenode.agent.components.PromptAssembler;

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
    /** 默认模型服务商（openai=OpenAI 兼容协议；anthropic=Anthropic Messages API）。 */
    public static final String DEFAULT_PROVIDER = "openai";
    /** max_tokens 缺省值（Anthropic 等协议必填输出上限）。 */
    public static final int DEFAULT_MAX_TOKENS = 8192;

    private final Path file;
    private final Properties properties = new Properties();
    private volatile List<Path> appliedHarnessConfigFiles = List.of();
    private volatile List<String> harnessConfigWarnings = List.of();
    private final WindowsCredentialStore credentialStore = new WindowsCredentialStore();
    private volatile String apiKeyCache;

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
        HarnessConfigResolver.Resolution resolution = HarnessConfigResolver.resolve(file);
        properties.clear();
        properties.putAll(resolution.properties());
        appliedHarnessConfigFiles = resolution.appliedFiles();
        harnessConfigWarnings = resolution.warnings();
        apiKeyCache = null;
    }

    public List<Path> appliedHarnessConfigFiles() { return appliedHarnessConfigFiles; }
    public List<String> harnessConfigWarnings() { return harnessConfigWarnings; }

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
    public synchronized String apiKey() {
        if (apiKeyCache != null) return apiKeyCache;
        Optional<String> secure = credentialStore.read(WindowsCredentialStore.targetFor(apiBase()));
        apiKeyCache = secure.orElseGet(() -> properties.getProperty("api_key", ""));
        return apiKeyCache;
    }
    public String model() { return properties.getProperty("model", DEFAULT_MODEL); }
    public String defaultProjectPath() { return properties.getProperty("default_project_path", ""); }

    /** 模型服务商：openai（OpenAI 兼容协议，默认）/ anthropic（Anthropic Messages API）。 */
    public String apiProvider() {
        String value = properties.getProperty("api_provider", DEFAULT_PROVIDER).trim().toLowerCase();
        return value.isBlank() ? DEFAULT_PROVIDER : value;
    }

    /** 输出 token 上限（max_tokens 属性；Anthropic 等协议必填，缺省 8192）。 */
    public int maxTokens() {
        return parseInt(properties.getProperty("max_tokens", String.valueOf(DEFAULT_MAX_TOKENS)), DEFAULT_MAX_TOKENS);
    }

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

    /** 会话级 token 预算上限（agent.budget.max_tokens_per_session；0=不限）。 */
    public long maxTokensPerSession() {
        try {
            return Long.parseLong(properties.getProperty("agent.budget.max_tokens_per_session", "0").trim());
        } catch (Exception e) {
            return 0;
        }
    }

    /** 模型上下文窗口 token 上限（agent.context_length；缺省 128000，0=关闭 token 触发自动压缩）。 */
    public long contextLength() {
        try {
            return Long.parseLong(properties.getProperty("agent.context_length", "128000").trim());
        } catch (Exception e) {
            return 128000;
        }
    }

    /** 工具结果回传给模型的最大字符数（tools.max_result_chars；缺省 4000）。 */
    public int maxToolResultChars() {
        return parseInt(properties.getProperty("tools.max_result_chars", "4000"), 4000);
    }

    /** 禁用的工具名列表（逗号分隔；空=全部启用）。禁用优先级高于 {@link #enabledTools()}。 */
    public List<String> disabledTools() {
        return parseList(properties.getProperty("tools.disabled", ""));
    }

    /** 仅启用的工具名列表（逗号分隔；空=不限制）。 */
    public List<String> enabledTools() {
        return parseList(properties.getProperty("tools.enabled", ""));
    }

    /** 追加到系统提示末尾的自定义提示（多行可用 \\n 转义）。 */
    public String extraHarnessPrompt() {
        String value = properties.getProperty("harness.extra_prompt", "");
        return value.replace("\\n", "\n").trim();
    }

    /** 是否启用 LLM 会话摘要（harness.llm_summary=true；默认 false=本地规则版，避免额外 API 调用）。 */
    public boolean llmSummaryEnabled() {
        return Boolean.parseBoolean(properties.getProperty("harness.llm_summary", "false").trim());
    }

    /** 启用的 harness 组件类别；空值使用全部内置组件。 */
    public List<String> harnessComponents() {
        List<String> configured = parseList(properties.getProperty("harness.components", ""));
        return configured.isEmpty() ? HarnessAssembler.DEFAULT_COMPONENTS : configured;
    }

    /** Named Cordis profile used to label and compose this harness instance. */
    public String harnessProfile() {
        String value = properties.getProperty("harness.profile", "default").trim();
        return value.isBlank() ? "default" : value;
    }

    /** Fully-qualified Cordis plugin classes to add to the selected profile. */
    public List<String> cordisPlugins() {
        return parseList(properties.getProperty("harness.plugins", ""));
    }

    /** 工具来源组件；默认启用内置工具与已配置的 MCP 来源。 */
    public List<String> toolsSources() {
        List<String> configured = parseList(properties.getProperty("tools.sources", ""));
        return configured.isEmpty() ? List.of("builtin", "mcp") : configured;
    }

    /** 系统提示分段组件的启用顺序。 */
    public List<String> promptSections() {
        List<String> configured = parseList(properties.getProperty("harness.prompt_sections", ""));
        return configured.isEmpty() ? PromptAssembler.DEFAULT_SECTIONS : configured;
    }

    /** 会话压缩组件：auto / llm / local / none。 */
    public String compactor() {
        String value = properties.getProperty("harness.compactor", "auto").trim().toLowerCase();
        return value.isBlank() ? "auto" : value;
    }

    /** 会话存储组件：file / memory / 第三方扩展名。 */
    public String sessionStore() {
        String value = properties.getProperty("harness.storage", "file").trim().toLowerCase();
        return value.isBlank() ? "file" : value;
    }

    /** Append-only trajectory backend: file / memory / third-party extension. */
    public String sessionEventStore() {
        String value = properties.getProperty("harness.session_log", "file").trim().toLowerCase();
        return value.isBlank() ? "file" : value;
    }

    /** harness 监听器组件列表，默认启用 trace。 */
    public List<String> harnessListeners() {
        List<String> configured = parseList(properties.getProperty("harness.listeners", ""));
        return configured.isEmpty() ? List.of("trace") : configured;
    }

    /** 规划组件每隔多少个工具步骤检查一次；0=禁用。 */
    public int planCheckInterval() {
        return Math.max(0, parseInt(properties.getProperty("harness.plan_check_interval", "3"), 3));
    }

    /** Agent loop 策略名称。 */
    public String loopPolicy() {
        String value = properties.getProperty("harness.loop", "default").trim().toLowerCase();
        return value.isBlank() ? "default" : value;
    }

    /** Whole-turn driver name (separate from the loop policy). */
    public String agentLoop() {
        String value = properties.getProperty("harness.agent_loop", "default").trim().toLowerCase();
        return value.isBlank() ? "default" : value;
    }

    /** Subagent service factory name. */
    public String agentSpawner() {
        String value = properties.getProperty("harness.agents", "default").trim().toLowerCase();
        return value.isBlank() ? "default" : value;
    }

    public int loopMaxRounds() { return parseInt(properties.getProperty("harness.loop.max_rounds", "10"), 10); }
    public int loopMaxRetries() { return parseInt(properties.getProperty("harness.loop.max_retries", "5"), 5); }
    public int loopDefaultTimeoutSeconds() { return parseInt(properties.getProperty("harness.loop.default_timeout_seconds", "60"), 60); }
    public int loopLongTimeoutSeconds() { return parseInt(properties.getProperty("harness.loop.long_timeout_seconds", "300"), 300); }

    // ---------- 外部 MCP server 配置（P1） ----------

    /** 启用的 MCP server 名列表（mcp.servers，逗号分隔；空=不启用）。 */
    public List<String> mcpServers() {
        return parseList(properties.getProperty("mcp.servers", ""));
    }

    /** 指定 MCP server 的命令行（mcp.server.<name>，| 分隔命令与参数）。 */
    public String mcpServerCommand(String name) {
        return properties.getProperty("mcp.server." + name, "");
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

    public void setApiBase(String value) { properties.setProperty("api_base", value == null ? "" : value.trim()); apiKeyCache = null; }
    public synchronized void setApiKey(String value) {
        String key = value == null ? "" : value.trim();
        if (key.isBlank()) { credentialStore.delete(WindowsCredentialStore.targetFor(apiBase())); properties.remove("api_key"); apiKeyCache = ""; return; }
        if (credentialStore.write(WindowsCredentialStore.targetFor(apiBase()), key)) { properties.remove("api_key"); }
        else { properties.setProperty("api_key", key); }
        apiKeyCache = key;
    }
    public void setModel(String value) { properties.setProperty("model", value == null || value.isBlank() ? DEFAULT_MODEL : value.trim()); }
    public void setModels(List<String> models) { properties.setProperty("models", models == null || models.isEmpty() ? "" : String.join(",", models)); }
    public void setApiProvider(String value) { properties.setProperty("api_provider", value == null || value.isBlank() ? DEFAULT_PROVIDER : value.trim().toLowerCase()); }
    public void setDefaultProjectPath(String value) { properties.setProperty("default_project_path", value == null ? "" : value.trim()); }

    public void setHarnessComponents(List<String> value) { setList("harness.components", value); }
    public void setHarnessProfile(String value) { properties.setProperty("harness.profile", value == null || value.isBlank() ? "default" : value.trim()); }
    public void setHarnessBundles(List<String> value) { setList("harness.bundles", value); }
    public void setHarnessPatches(List<String> value) { setList("harness.patches", value); }
    public void setCordisPlugins(List<String> value) { setList("harness.plugins", value); }
    public void setToolsSources(List<String> value) { setList("tools.sources", value); }
    public void setPromptSections(List<String> value) { setList("harness.prompt_sections", value); }
    public void setCompactor(String value) { properties.setProperty("harness.compactor", value == null || value.isBlank() ? "auto" : value.trim().toLowerCase()); }
    public void setSessionStore(String value) { properties.setProperty("harness.storage", value == null || value.isBlank() ? "file" : value.trim().toLowerCase()); }
    public void setSessionEventStore(String value) { properties.setProperty("harness.session_log", value == null || value.isBlank() ? "file" : value.trim().toLowerCase()); }
    public void setHarnessListeners(List<String> value) { setList("harness.listeners", value); }
    public void setPlanCheckInterval(int value) { properties.setProperty("harness.plan_check_interval", String.valueOf(Math.max(0, value))); }
    public void setLoopPolicy(String value) { properties.setProperty("harness.loop", value == null || value.isBlank() ? "default" : value.trim().toLowerCase()); }
    public void setAgentLoop(String value) { properties.setProperty("harness.agent_loop", value == null || value.isBlank() ? "default" : value.trim().toLowerCase()); }
    public void setAgentSpawner(String value) { properties.setProperty("harness.agents", value == null || value.isBlank() ? "default" : value.trim().toLowerCase()); }
    public void setLoopMaxRounds(int value) { properties.setProperty("harness.loop.max_rounds", String.valueOf(value)); }
    public void setLoopMaxRetries(int value) { properties.setProperty("harness.loop.max_retries", String.valueOf(value)); }
    public void setLoopDefaultTimeoutSeconds(int value) { properties.setProperty("harness.loop.default_timeout_seconds", String.valueOf(value)); }
    public void setLoopLongTimeoutSeconds(int value) { properties.setProperty("harness.loop.long_timeout_seconds", String.valueOf(value)); }

    private void setList(String key, List<String> value) {
        properties.setProperty(key, value == null || value.isEmpty() ? "" : String.join(",", value));
    }
}
