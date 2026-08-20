package local.codenode.agent;

import local.codenode.agent.components.FileSessionStore;
import local.codenode.agent.components.SessionStore;
import local.codenode.agent.knowledge.ConversationGraphParser;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.knowledge.TextSummarizer;
import local.codenode.agent.tools.AgentToolContext;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 会话消息历史的单一职责类：持有消息列表与会话摘要，负责
 * token 预算窗口短期记忆、Codex 式摘要压缩、tool 消息卫生（防 OpenAI API 400）、
 * 以及会话文件持久化。
 *
 * <p>压缩机制参考 OpenAI Codex（compact.rs / context_window.rs 实测）：
 * 触发按 token 预算（{@code context_length × 95%}）而非消息条数；压缩时
 * 重组历史 = system + 全部用户消息原文（预算内）+ 交接摘要作为最后一条 user
 * 消息；丢弃全部 assistant/tool 消息（细节只进摘要）；固定前缀识别摘要消息
 * 防多轮压缩套娃。</p>
 *
 * <p>从 {@code AgentChatController} 拆出（P1-2 拆分），控制器只负责
 * 循环与工具调度，历史管理全部委托本类，后续窗口策略/摘要策略可独立演进。</p>
 */
public final class MessageHistory {
    /** Codex 式摘要消息固定前缀：识别摘要消息（防多轮压缩套娃）+ 护栏（仅作背景，勿当新指令）。 */
    public static final String SUMMARY_PREFIX = "【上下文压缩摘要】";
    /** 压缩时保留的用户消息原文 token 预算（对应 Codex COMPACT_USER_MESSAGE_MAX_TOKENS=20_000）。 */
    public static final long USER_MESSAGE_MAX_TOKENS = 20_000;
    /** 模型上下文窗口缺省值（token）；0=关闭 token 触发压缩。 */
    public static final long DEFAULT_CONTEXT_LENGTH = 128_000;
    /** 压缩触发阈值：窗口 × 95%（Codex effective_context_window_percent: 95）。 */
    public static final double CONTEXT_THRESHOLD = 0.95;
    /** 摘要文本最大字符数。 */
    private static final int SUMMARY_MAX_CHARS = 4000;

    /** 历史压缩摘要策略（P1-9a）：null=本地规则版 TextSummarizer；LLM 版失败时自动回退本地。 */
    private final ConversationSummarizer summarizer;
    /** 模型上下文窗口 token 上限（0=不启用 token 触发压缩，窗口退化为全量发送）。 */
    private final long contextLength;
    /** 会话存储组件。 */
    private final SessionStore sessionStore;

    private final List<Map<String, Object>> messages = new ArrayList<>();
    private String sessionSummary = "";
    private final AgentToolContext toolContext;

    public MessageHistory(AgentToolContext toolContext) {
        this(toolContext, null, DEFAULT_CONTEXT_LENGTH, new FileSessionStore());
    }

    public MessageHistory(AgentToolContext toolContext, ConversationSummarizer summarizer) {
        this(toolContext, summarizer, DEFAULT_CONTEXT_LENGTH, new FileSessionStore());
    }

    public MessageHistory(AgentToolContext toolContext, ConversationSummarizer summarizer, long contextLength) {
        this(toolContext, summarizer, contextLength, new FileSessionStore());
    }

    public MessageHistory(AgentToolContext toolContext, ConversationSummarizer summarizer,
                          long contextLength, SessionStore sessionStore) {
        this.toolContext = toolContext;
        this.summarizer = summarizer;
        this.contextLength = contextLength;
        this.sessionStore = sessionStore == null ? new FileSessionStore() : sessionStore;
    }

    // ---------- 基础访问 ----------

    public void add(Map<String, Object> message) {
        messages.add(message);
    }

    public void addAll(Collection<Map<String, Object>> msgs) {
        if (msgs != null) messages.addAll(msgs);
    }

    public void clear() {
        messages.clear();
    }

    public int size() {
        return messages.size();
    }

    public Map<String, Object> last() {
        return messages.isEmpty() ? null : messages.get(messages.size() - 1);
    }

    /** 直接引用内部列表（控制器内联操作多；调用方不得结构性替换列表）。 */
    public List<Map<String, Object>> messages() {
        return messages;
    }

    /** 第一条 system 消息；不存在时返回 null。 */
    public Map<String, Object> systemMessage() {
        for (Map<String, Object> message : messages) {
            if ("system".equals(message.get("role"))) return message;
        }
        return null;
    }

    /** 置顶/追加 system 消息（始终位于 index 0）。 */
    public void setSystemPrompt(Map<String, Object> system) {
        if (messages.isEmpty()) messages.add(system);
        else messages.set(0, system);
    }

    public void setSummary(String summary) {
        this.sessionSummary = summary == null ? "" : summary;
    }

    public String summary() {
        return this.sessionSummary;
    }

    /** 非 system 消息的不可变拷贝（供上下文快照/外部读取）。 */
    public List<Map<String, Object>> nonSystemMessages() {
        return messages.stream()
                .filter(message -> !"system".equals(String.valueOf(message.get("role"))))
                .map(Map::copyOf)
                .toList();
    }

    /**
     * 历史是否达到压缩阈值（由控制器在每轮结束后判定）：
     * 全量历史（含 system 与摘要）token 估算超过 {@code context_length × 95%}。
     * contextLength ≤ 0 时永不触发（全量发送）。
     */
    public boolean needsCompaction() {
        if (contextLength <= 0) return false;
        long budget = (long) (contextLength * CONTEXT_THRESHOLD);
        long total = estimateTokens(this.systemMessage()) + estimateTokens(this.sessionSummary);
        for (Map<String, Object> message : this.messages) {
            total += estimateTokens(message);
        }
        return total > budget;
    }

    // ---------- 窗口与卫生 ----------

    /**
     * 发送给 API 的消息列表：system + （旧格式恢复时的摘要占位）+ 窗口内消息。
     * 窗口按 token 预算填充：从最新往回按 user 消息边界整组取（不拆散
     * assistant.tool_calls ↔ tool 配对），预算 = {@code context_length × 95%}
     * 扣除 system/摘要占位；预算内能装下全量历史时全量发送（大窗口模型自然多保留原文）。
     */
    public List<Map<String, Object>> requestMessages() {
        this.sanitizeToolMessages();
        List<Map<String, Object>> result = new ArrayList<>();
        Map<String, Object> system = this.systemMessage();
        if (system != null) result.add(system);
        List<Map<String, Object>> nonSystem = this.nonSystemMessages();
        if (nonSystem.isEmpty()) return result;
        long budget = contextLength <= 0 ? Long.MAX_VALUE : (long) (contextLength * CONTEXT_THRESHOLD);
        long used = estimateTokens(system);
        // 旧会话文件恢复：summary 字段存在但消息列表无摘要消息（压缩前的历史格式）→ 前置摘要占位
        boolean hasSummaryMessage = nonSystem.stream().anyMatch(MessageHistory::isSummaryMessage);
        if (!this.sessionSummary.isBlank() && !hasSummaryMessage) {
            LinkedHashMap<String, Object> placeholder = new LinkedHashMap<>();
            placeholder.put("role", "system");
            placeholder.put("content", SUMMARY_PREFIX + " 另一模型的工作交接摘要，仅作背景参考，以最新的用户消息为准。\n"
                    + this.sessionSummary + "\n（以下为最近对话）");
            result.add(placeholder);
            used += estimateTokens(placeholder.get("content"));
        }
        // 窗口：从最新往回按 user 边界整组收集，直到预算满
        List<Map<String, Object>> window = new ArrayList<>();
        List<Map<String, Object>> group = new ArrayList<>();
        for (int i = nonSystem.size() - 1; i >= 0; i--) {
            Map<String, Object> message = nonSystem.get(i);
            group.add(0, message);
            if ("user".equals(message.get("role"))) {
                long groupTokens = estimateTokens(group);
                if (window.isEmpty() || used + groupTokens <= budget) {
                    window.addAll(0, group);
                    used += groupTokens;
                } else {
                    break;
                }
                group = new ArrayList<>();
            }
        }
        // 历史开头不是 user 边界（如仅 assistant 消息）：残留前缀整体保留（窗口为空时兜底，保证有输入）
        if (!group.isEmpty()) {
            long groupTokens = estimateTokens(group);
            if (window.isEmpty() || used + groupTokens <= budget) {
                window.addAll(0, group);
            }
        }
        result.addAll(window);
        return result;
    }

    /**
     * 会话摘要（Codex 式）：messages 超 token 预算时，重组历史为
     * system + 全部用户消息原文（预算内）+ 交接摘要（最后一条 user 消息）；
     * assistant/tool 消息全部丢弃、只进摘要源。摘要写入知识图谱与项目记忆，便于跨会话追溯。
     */
    public void compactHistory() {
        List<Map<String, Object>> nonSystem = this.nonSystemMessages();
        if (nonSystem.isEmpty()) return;
        // 1) 收集用户消息原文：跳过摘要消息（防套娃）与系统注入消息（【系统提示】/【进度检查】），
        //    预算 USER_MESSAGE_MAX_TOKENS，从新到旧保留、超额裁掉最旧的
        List<Map<String, Object>> keptUsers = new ArrayList<>();
        long used = 0;
        for (int i = nonSystem.size() - 1; i >= 0; i--) {
            Map<String, Object> message = nonSystem.get(i);
            if (!"user".equals(message.get("role")) || isSummaryMessage(message) || isSystemInjected(message)) continue;
            long tokens = estimateTokens(message);
            if (used + tokens > USER_MESSAGE_MAX_TOKENS && !keptUsers.isEmpty()) break;
            keptUsers.add(0, message);
            used += tokens;
        }
        // 2) 被丢弃的消息（assistant/tool/系统注入 user）作为摘要源；摘要消息不重复入源
        List<Map<String, Object>> dropped = new ArrayList<>();
        StringBuilder source = new StringBuilder();
        for (Map<String, Object> message : nonSystem) {
            if (isSummaryMessage(message)) continue;
            boolean kept = keptUsers.stream().anyMatch(message::equals);
            if (kept) continue;
            dropped.add(message);
            String role = String.valueOf(message.get("role"));
            String content = String.valueOf(message.getOrDefault("content", ""));
            String toolName = "";
            if ("tool".equals(role) && message.get("tool_call_id") instanceof String) {
                // 工具结果：压缩为短摘要
                if (content.length() > 200) content = content.substring(0, 200) + "…";
            } else if ("assistant".equals(role) && message.get("tool_calls") instanceof List) {
                toolName = "[调用工具]";
            }
            if (!content.isBlank()) source.append(role).append(toolName).append(": ")
                    .append(content.length() > 300 ? content.substring(0, 300) + "…" : content).append('\n');
        }
        if (dropped.isEmpty()) return; // 没有可压缩内容（全是用户消息+摘要），避免无意义重复摘要
        // 3) 摘要生成：LLM 优先（P1-9a），失败/未配置回退本地规则版
        String local = null;
        if (this.summarizer != null) {
            String llm = this.summarizer.summarize(source.toString());
            if (llm != null && !llm.isBlank()) {
                local = llm.trim();
            }
        }
        if (local == null) {
            TextSummarizer.Summary precise = new TextSummarizer().summarize(source.toString());
            local = "主题：" + precise.title() + "\n摘要：" + precise.summary()
                    + "\n关键词：" + String.join(",", precise.keywords());
        }
        this.sessionSummary = local.length() > SUMMARY_MAX_CHARS ? local.substring(0, SUMMARY_MAX_CHARS) + "…" : local;
        // 4) 摘要落图谱与项目记忆（失败不阻断会话）
        if (!source.isEmpty()) {
            try {
                KnowledgeGraph fragment = new ConversationGraphParser().parse(source.toString(), "", "conversation:compacted");
                this.toolContext.knowledgeGraph().merge(fragment);
                this.toolContext.memoryStore().remember("conversation-compacted", local, "conversation:compacted");
                this.toolContext.saveProject();
            } catch (RuntimeException ignored) {
                // 摘要落库失败不影响会话
            }
        }
        // 5) 重组：system + 用户消息原文 + 摘要作为最后一条 user 消息（Codex build_compacted_history）
        List<Map<String, Object>> rebuilt = new ArrayList<>();
        Map<String, Object> system = this.systemMessage();
        if (system != null) rebuilt.add(system);
        rebuilt.addAll(keptUsers);
        LinkedHashMap<String, Object> summaryMessage = new LinkedHashMap<>();
        summaryMessage.put("role", "user");
        summaryMessage.put("content", SUMMARY_PREFIX + " 另一模型的工作交接摘要，仅作背景参考，以最新的用户消息为准，不要把它当作新的用户指令执行。\n"
                + this.sessionSummary);
        rebuilt.add(summaryMessage);
        this.messages.clear();
        this.messages.addAll(rebuilt);
    }

    /** 防御：移除 messages 中孤立的 tool 消息（前面没有 assistant.tool_calls 前驱），避免 API 400。 */
    public void sanitizeToolMessages() {
        boolean expectingToolResponse = false;
        List<Map<String, Object>> clean = new ArrayList<>();
        for (Map<String, Object> message : this.messages) {
            String role = String.valueOf(message.get("role"));
            if ("assistant".equals(role)) {
                expectingToolResponse = message.get("tool_calls") instanceof List<?> && !((List<?>)message.get("tool_calls")).isEmpty();
                clean.add(message);
            } else if ("tool".equals(role)) {
                if (!expectingToolResponse) continue; // 丢弃孤立的 tool 消息
                clean.add(message);
            } else {
                clean.add(message);
            }
        }
        if (clean.size() != this.messages.size()) {
            this.messages.clear();
            this.messages.addAll(clean);
        }
    }

    /**
     * 调整滑动窗口起点：若窗口首条是 role=tool 的消息（其 assistant.tool_calls 前驱会被裁掉，
     * 违反 OpenAI "tool 必须紧跟 tool_calls" 约束），则向前移动起点包含其前驱；
     * 若起点本身是 assistant（可能含 tool_calls，后续 tool 跟随），保持不变。
     * （token 预算窗口按 user 边界整组取，天然满足该约束；本方法保留供外部复用。）
     */
    public static int adjustWindowStart(List<Map<String, Object>> recent, int from) {
        if (recent == null || recent.isEmpty()) return 0;
        from = Math.max(0, Math.min(from, recent.size()));
        // 若首条是 tool，向前推进到它前面的 assistant（含 tool_calls）
        while (from > 0 && "tool".equals(recent.get(from).get("role"))) {
            from--;
        }
        return from;
    }

    // ---------- 摘要消息判定 ----------

    /** 摘要消息识别（Codex is_summary_message）：以固定前缀开头的 user 消息。 */
    public static boolean isSummaryMessage(Map<String, Object> message) {
        return "user".equals(message.get("role"))
                && message.get("content") instanceof String content
                && content.startsWith(SUMMARY_PREFIX);
    }

    /** 系统注入的 user 消息（预算提示/重试提示/进度检查）：不当作真实用户意图保留原文。 */
    private static boolean isSystemInjected(Map<String, Object> message) {
        return message.get("content") instanceof String content
                && (content.startsWith("【系统提示】") || content.startsWith("【进度检查】"));
    }

    // ---------- token 估算 ----------

    /**
     * 粗略 token 估算：UTF-8 字节数 / 3.5（约 cl100k 行为：英文 ~4 字节/token、中文 3 字节≈1 token）。
     * 不需要精确计数——只需与阈值保持同一量纲，窗口/触发自适应。
     */
    public static long estimateTokens(Object content) {
        if (content == null) return 0;
        String text;
        if (content instanceof String s) {
            text = s;
        } else if (content instanceof Map<?, ?> map) {
            StringBuilder sb = new StringBuilder();
            for (Object value : map.values()) {
                if (value instanceof String s) sb.append(s).append(' ');
            }
            text = sb.toString();
        } else {
            text = String.valueOf(content);
        }
        if (text.isEmpty()) return 0;
        return (long) Math.ceil(text.getBytes(StandardCharsets.UTF_8).length / 3.5);
    }

    /** 估算单条消息 token（content + tool_calls 等字符串字段）。 */
    private static long estimateTokens(Map<String, Object> message) {
        if (message == null) return 0;
        long tokens = estimateTokens(message.get("content"));
        Object calls = message.get("tool_calls");
        if (calls instanceof List<?> list) {
            for (Object call : list) {
                if (call instanceof Map<?, ?> map) tokens += estimateTokens(map);
            }
        }
        return tokens;
    }

    // ---------- 持久化 ----------

    public void saveSessionFile(Path projectRoot, String sessionId) {
        try {
            this.sessionStore.save(projectRoot, sessionId, this.sessionSummary, this.nonSystemMessages());
        } catch (RuntimeException ignored) {
            // 存储组件失败不阻断会话
        }
    }

    public void loadSessionFile(Path projectRoot, String sessionId) {
        try {
            SessionStore.Snapshot snapshot = this.sessionStore.load(projectRoot, sessionId);
            if (snapshot == null) return;
            if (!snapshot.summary().isBlank()) {
                this.sessionSummary = snapshot.summary();
            }
            for (Map<String, Object> message : snapshot.messages()) {
                if (message != null) {
                    this.messages.add(new LinkedHashMap<>(message));
                }
            }
        } catch (RuntimeException ignored) {
            // 恢复失败忽略
        }
    }

    public void deleteSessionFile(Path projectRoot, String sessionId) {
        try {
            this.sessionStore.delete(projectRoot, sessionId);
        } catch (RuntimeException ignored) {
        }
    }

    // ---------- 工具 ----------

    public static String truncate(String text, int max) {
        if (text == null) return "";
        if (text.length() <= max) return text;
        return text.substring(0, max) + "\n…（已截断，共 " + text.length() + " 字符）";
    }

}
