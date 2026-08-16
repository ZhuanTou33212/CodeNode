package local.codenode.agent;

import local.codenode.Json;
import local.codenode.agent.knowledge.ConversationGraphParser;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.knowledge.TextSummarizer;
import local.codenode.agent.tools.AgentToolContext;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 会话消息历史的单一职责类：持有消息列表与会话摘要，负责
 * 滑动窗口短期记忆、摘要压缩、tool 消息卫生（防 OpenAI API 400）、
 * 以及会话文件持久化。
 *
 * <p>从 {@code AgentChatController} 拆出（P1-2 拆分），控制器只负责
 * 循环与工具调度，历史管理全部委托本类，后续窗口策略/摘要策略可独立演进。</p>
 */
public final class MessageHistory {
    /** 发送给 API 前保留的最大消息数（system 除外）。 */
    private static final int MAX_HISTORY_MESSAGES = 20;
    /** 触发摘要压缩的历史消息阈值。 */
    private static final int SUMMARY_THRESHOLD = 40;

    /** 历史压缩摘要策略（P1-9a）：null=本地规则版 TextSummarizer；LLM 版失败时自动回退本地。 */
    private final ConversationSummarizer summarizer;

    private final List<Map<String, Object>> messages = new ArrayList<>();
    private String sessionSummary = "";
    private final AgentToolContext toolContext;

    public MessageHistory(AgentToolContext toolContext) {
        this(toolContext, null);
    }

    public MessageHistory(AgentToolContext toolContext, ConversationSummarizer summarizer) {
        this.toolContext = toolContext;
        this.summarizer = summarizer;
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

    /** 历史是否达到压缩阈值（由控制器在每轮结束后判定）。 */
    public boolean needsCompaction() {
        return nonSystemMessages().size() > SUMMARY_THRESHOLD;
    }

    // ---------- 窗口与卫生 ----------

    /** 发送给 API 的消息列表：system + 摘要占位 + 最近 N 条（滑动窗口短期记忆）。 */
    public List<Map<String, Object>> requestMessages() {
        this.sanitizeToolMessages();
        List<Map<String, Object>> result = new ArrayList<>();
        Map<String, Object> system = this.systemMessage();
        if (system != null) result.add(system);
        if (!this.sessionSummary.isBlank()) {
            LinkedHashMap<String, Object> summary = new LinkedHashMap<>();
            summary.put("role", "system");
            summary.put("content", "【早期会话摘要】" + this.sessionSummary + "\n（以下为最近对话）");
            result.add(summary);
        }
        List<Map<String, Object>> recent = this.nonSystemMessages();
        int from = MessageHistory.adjustWindowStart(recent, recent.size() - MAX_HISTORY_MESSAGES);
        for (int i = from; i < recent.size(); i++) {
            result.add(recent.get(i));
        }
        return result;
    }

    /**
     * 会话摘要：messages 超阈值时，把早期消息压缩为一段摘要（本地规则版，避免额外 API 调用与失败风险）。
     * 摘要写入知识图谱与项目记忆，便于跨会话追溯。
     */
    public void compactHistory() {
        List<Map<String, Object>> nonSystem = this.nonSystemMessages();
        if (nonSystem.size() <= SUMMARY_THRESHOLD) return;
        int keepFrom = MessageHistory.adjustWindowStart(nonSystem, nonSystem.size() - MAX_HISTORY_MESSAGES);
        StringBuilder sb = new StringBuilder();
        sb.append(this.sessionSummary.isBlank() ? "" : this.sessionSummary + "\n");
        List<Map<String, Object>> early = nonSystem.subList(0, keepFrom);
        StringBuilder source = new StringBuilder();
        for (Map<String, Object> message : early) {
            String role = String.valueOf(message.get("role"));
            String content = String.valueOf(message.getOrDefault("content", ""));
            String toolName = "";
            if ("tool".equals(role) && message.get("tool_call_id") instanceof String) {
                // 工具结果：压缩为短摘要
                if (content.length() > 200) content = content.substring(0, 200) + "…";
            } else if ("assistant".equals(role) && message.get("tool_calls") instanceof List) {
                toolName = "[调用工具]";
            }
            sb.append(role).append(toolName).append(": ").append(content.length() > 300 ? content.substring(0, 300) + "…" : content).append("\n");
            if (!content.isBlank()) source.append(role).append(": ").append(content).append('\n');
        }
        TextSummarizer.Summary precise = null;
        String local = null;
        // P1-9a：配置了 LLM 摘要时优先用模型压缩（质量更高），失败/未配置回退本地规则版
        if (this.summarizer != null) {
            String llm = this.summarizer.summarize(source.toString());
            if (llm != null && !llm.isBlank()) {
                local = llm.trim();
            }
        }
        if (local == null) {
            precise = new TextSummarizer().summarize(source.toString());
            local = "主题：" + precise.title() + "\n摘要：" + precise.summary()
                    + "\n关键词：" + String.join(",", precise.keywords());
        }
        this.sessionSummary = local.length() > 4000 ? local.substring(0, 4000) + "…" : local;
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
        // 裁剪消息：保留 system + 最近窗口（确保窗口首条不是孤立的 tool 消息）
        List<Map<String, Object>> kept = new ArrayList<>();
        Map<String, Object> system = this.systemMessage();
        if (system != null) kept.add(system);
        kept.addAll(nonSystem.subList(keepFrom, nonSystem.size()));
        this.messages.clear();
        this.messages.addAll(kept);
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

    // ---------- 持久化 ----------

    public void saveSessionFile(Path projectRoot, String sessionId) {
        try {
            Path dir = projectRoot.resolve(".codenode/agent-sessions");
            Files.createDirectories(dir);
            LinkedHashMap<String, Object> record = new LinkedHashMap<>();
            record.put("sessionId", sessionId);
            record.put("summary", this.sessionSummary);
            record.put("messages", this.nonSystemMessages());
            Files.writeString(dir.resolve(sessionId + ".json"), Json.stringify(record),
                    StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException ignored) {
            // 持久化失败不阻断会话
        }
    }

    public void loadSessionFile(Path projectRoot, String sessionId) {
        try {
            Path file = projectRoot.resolve(".codenode/agent-sessions").resolve(sessionId + ".json");
            if (!Files.isRegularFile(file)) return;
            Map<String, Object> record = Json.object(Files.readString(file, StandardCharsets.UTF_8));
            if (record.get("summary") instanceof String summary && !summary.isBlank()) {
                this.sessionSummary = summary;
            }
            if (record.get("messages") instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof Map<?, ?> map) {
                        this.messages.add(MessageHistory.toStringMap(map));
                    }
                }
            }
        } catch (Exception ignored) {
            // 恢复失败忽略
        }
    }

    public void deleteSessionFile(Path projectRoot, String sessionId) {
        try {
            Files.deleteIfExists(projectRoot.resolve(".codenode/agent-sessions").resolve(sessionId + ".json"));
        } catch (IOException ignored) {
        }
    }

    // ---------- 工具 ----------

    public static String truncate(String text, int max) {
        if (text == null) return "";
        if (text.length() <= max) return text;
        return text.substring(0, max) + "\n…（已截断，共 " + text.length() + " 字符）";
    }

    private static Map<String, Object> toStringMap(Map<?, ?> map) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }
}
