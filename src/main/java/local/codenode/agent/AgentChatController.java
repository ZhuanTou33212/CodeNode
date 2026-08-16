package local.codenode.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import local.codenode.AgentProvider;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.Json;
import local.codenode.agent.ChatEvent;
import local.codenode.agent.ChatListener;
import local.codenode.agent.OpenAiChatClient;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.AgentToolSpec;
import local.codenode.agent.knowledge.ConversationGraphParser;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.knowledge.TextSummarizer;
import local.codenode.config.AgentConfig;

/**
 * 会话状态机 / 取消 / 工具调度 / 短期记忆（滑动窗口 + 摘要） / 持久化。
 * 状态：IDLE → ACTIVE_RUNNING → IDLE；requestStop → CANCELLED → IDLE。
 * 多轮会话维护消息历史；模型触发 tool_calls 时经 AgentToolRegistry 本地执行并回传结果。
 */
public final class AgentChatController {
    private static final int MAX_TOOL_LOOP = 10;
    /** 工具失败/空结果后主动提示继续尝试的上限（避免死循环）。 */
    private static final int MAX_TOOL_RETRY = 5;
    /** 规划层：每完成 N 个工具步骤注入一次进度检查（对照任务清单）。 */
    private static final int PLAN_CHECK_INTERVAL = 3;
    /** 单个工具执行的最大等待秒数（外层兜底超时，防止工具阻塞卡死）。 */
    private static final int DEFAULT_TOOL_TIMEOUT_SECONDS = 60;
    /** 长耗时工具（构建/运行/编译）的默认超时秒数。 */
    private static final int LONG_TOOL_TIMEOUT_SECONDS = 300;
    /** 窗口/摘要/截断策略已迁移至 MessageHistory 与 AgentConfig。 */

    private final AgentConfig config;
    private ChatClient client;
    private final AgentToolRegistry tools;
    private final AgentToolContext toolContext;
    private final AgentExecutionTimeline timeline = new AgentExecutionTimeline();
    /** 会话消息历史（滑动窗口/摘要/卫生/持久化，P1-2 拆分）。 */
    private final MessageHistory history;
    private final ExecutorService toolExecutor = Executors.newCachedThreadPool();
    private String sessionId = UUID.randomUUID().toString();
    private volatile AgentProvider.SessionState state = AgentProvider.SessionState.IDLE;
    private volatile boolean stopRequested;
    private SubagentManager subagents;
    /** 本会话（tab）独立的可变状态：工具停止标志与权限确认记忆。 */
    private final AgentSessionScope sessionScope = new AgentSessionScope();
    /** 执行 trace 写入器（.codenode/agent-traces/<sessionId>.jsonl，每轮会话重建）。 */
    private volatile AgentTraceWriter trace;

    public AgentChatController(AgentConfig config, AgentToolRegistry tools, AgentToolContext toolContext) {
        this.config = config;
        this.client = createChatClient(config);
        this.tools = tools;
        this.toolContext = toolContext;
        // P1-9a：harness.llm_summary=true 时启用 LLM 会话摘要（失败自动回退本地规则版）
        this.history = new MessageHistory(toolContext,
                config.llmSummaryEnabled() ? new LlmConversationSummarizer(this.client) : null);
        this.sessionScope.budget().setLimit(config.maxTokensPerSession());
    }

    /** 按配置的 api_provider 创建生产 client，并套重试退避装饰器。 */
    private static ChatClient createChatClient(AgentConfig config) {
        ChatClient raw = "anthropic".equals(config.apiProvider())
                ? new AnthropicChatClient(config)
                : new OpenAiChatClient(config);
        return new RetryingChatClient(raw);
    }

    /** 测试/评估构造：注入脚本化 ChatClient，harness 行为可确定性验证。 */
    public AgentChatController(AgentToolRegistry tools, AgentToolContext toolContext, ChatClient client) {
        this.config = new AgentConfig();
        this.tools = tools;
        this.toolContext = toolContext;
        this.history = new MessageHistory(toolContext);
        this.client = java.util.Objects.requireNonNull(client, "client");
    }

    public AgentExecutionTimeline timeline() {
        return this.timeline;
    }

    public AgentProvider.SessionState state() {
        return this.state;
    }

    public ChatClient client() {
        return this.client;
    }

    /** 会话级 token 预算（测试可直接设置上限验证预算拦截行为）。 */
    public local.codenode.agent.TokenBudget tokenBudget() {
        return this.sessionScope.budget();
    }

    public AgentToolRegistry tools() {
        return this.tools;
    }

    public String sessionId() {
        return this.sessionId;
    }

    /** Background agents owned by this chat tab. */
    public synchronized SubagentManager subagentManager() {
        if (subagents == null) subagents = new SubagentManager(this::runSubagent);
        return subagents;
    }

    private String runSubagent(String task, String relevantContext, SubagentManager.Cancellation cancellation) throws Exception {
        AgentChatController child = new AgentChatController(config, tools, toolContext);
        java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
        StringBuilder streamed = new StringBuilder();
        String prompt = task + (relevantContext == null || relevantContext.isBlank() ? ""
                : "\n\nRelevant context supplied by the parent agent:\n" + relevantContext);
        child.sendMessage(prompt, event -> {
            if (event.kind() == ChatEventKind.STREAM) streamed.append(event.text());
            else if (event.kind() == ChatEventKind.ERROR) result.completeExceptionally(new IllegalStateException(event.error()));
            else if (event.kind() == ChatEventKind.CANCELLED) result.completeExceptionally(new InterruptedException("subagent cancelled"));
            else if (event.kind() == ChatEventKind.STATE && event.state() == AgentProvider.SessionState.IDLE) {
                String text = streamed.toString().trim();
                if (text.isBlank()) {
                    List<Map<String, Object>> history = child.messageHistory();
                    for (int i = history.size() - 1; i >= 0; i--) {
                        Map<String, Object> message = history.get(i);
                        if ("assistant".equals(message.get("role")) && message.get("content") != null) {
                            text = String.valueOf(message.get("content")).trim(); break;
                        }
                    }
                }
                result.complete(text);
            }
        });
        while (!result.isDone()) {
            if (cancellation.isCancelled()) {
                child.requestStop();
                throw new InterruptedException("subagent cancelled");
            }
            try { return result.get(200, TimeUnit.MILLISECONDS); }
            catch (TimeoutException ignored) { }
        }
        return result.get();
    }

    public void reset() {
        deleteSessionFile();
        this.history.clear();
        this.history.setSummary("");
        this.sessionId = UUID.randomUUID().toString();
        this.state = AgentProvider.SessionState.IDLE;
        this.stopRequested = false;
        this.sessionScope.clearToolStop();
        this.sessionScope.permissionMemory().clear();
        this.sessionScope.budget().reset();
    }

    /** Clear the active conversation without deleting project-scoped knowledge. */
    public void clearForDocumentSwitch() {
        this.history.clear();
        this.history.setSummary("");
        this.sessionId = UUID.randomUUID().toString();
        this.state = AgentProvider.SessionState.IDLE;
        this.stopRequested = false;
        this.sessionScope.clearToolStop();
        this.sessionScope.permissionMemory().clear();
        this.sessionScope.budget().reset();
    }

    public AgentContext snapshotContext() {
        return AgentContext.of(this.sessionId, this.history.summary(), this.history.nonSystemMessages());
    }

    /** Restore a document-level context while retaining the current live system prompt. */
    public void restoreContext(AgentContext context) {
        clearForDocumentSwitch();
        if (context == null) return;
        this.sessionId = context.sessionId().isBlank() ? UUID.randomUUID().toString() : context.sessionId();
        this.history.add(this.systemPrompt());
        this.history.setSummary(context.summary());
        context.messages().stream()
                .filter(message -> !"system".equals(String.valueOf(message.get("role"))))
                .forEach(this.history::add);
    }
    public List<Map<String, Object>> messageHistory() {
        return this.history.nonSystemMessages();
    }

    public String summary() {
        return this.history.summary();
    }

    public void sendMessage(String userText, ChatListener listener) {
        if (this.state != AgentProvider.SessionState.IDLE) {
            listener.onEvent(ChatEvent.error("上一条消息仍在处理中，请先停止或等待完成"));
            return;
        }
        if (userText == null || userText.isBlank()) {
            return;
        }
        if (this.history.size() == 0) {
            this.history.add(this.systemPrompt());
            this.loadSessionFile();
        } else {
            this.history.setSystemPrompt(this.systemPrompt());
        }
        this.state = AgentProvider.SessionState.ACTIVE_RUNNING;
        this.timeline.beginTask(userText);
        this.stopRequested = false;
        listener.onEvent(ChatEvent.state(this.state));
        this.trace = new AgentTraceWriter(this.toolContext.projectRoot(), this.sessionId);
        this.trace.event("session_start", Map.of("task", userText));
        this.history.add(Map.of("role", "user", "content", userText));
        List<KnowledgeGraph.Conflict> observedConflicts = this.toolContext.knowledgeGraph().detectTextConflicts(userText);
        if (!observedConflicts.isEmpty()) {
            this.toolContext.knowledgeGraph().recordConflicts(observedConflicts);
            this.toolContext.audit("memory conflict proposal detected count=" + observedConflicts.size());
            this.history.setSystemPrompt(this.systemPrompt());
        }
        this.saveSessionFile();
        Thread.startVirtualThread(() -> {
            try {
                this.runTurnLoop(listener);
            }
            catch (InterruptedException interrupted) {
                this.timeline.cancelTask();
                this.traceEvent("error", Map.of("kind", "cancelled", "message", interrupted.getMessage()));
                listener.onEvent(ChatEvent.cancelled());
            }
            catch (Exception failure) {
                this.timeline.failTask();
                this.traceEvent("error", Map.of("kind", "exception",
                        "message", failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage()));
                listener.onEvent(ChatEvent.error(failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage()));
            }
            finally {
                if (!this.stopRequested && this.timeline.snapshot().taskState() != AgentExecutionTimeline.TaskState.FAILED) {
                    this.timeline.completeTask();
                }
                this.traceEvent("session_end", Map.of("state", String.valueOf(this.timeline.snapshot().taskState()),
                        "steps", this.timeline.snapshot().steps().size()));
                this.state = AgentProvider.SessionState.IDLE;
                listener.onEvent(ChatEvent.state(this.state));
            }
        });
    }

    private void traceEvent(String type, Map<String, Object> fields) {
        AgentTraceWriter writer = this.trace;
        if (writer != null) writer.event(type, fields);
    }

    /** 规划层进度检查提示：已完成步骤 + 任务清单，要求模型对照目标继续。 */
    private String planCheckPrompt(int doneSteps) {
        StringBuilder sb = new StringBuilder("【进度检查】任务尚未完成。当前已完成 ")
                .append(doneSteps).append(" 步工具调用，最近步骤：\n");
        List<AgentExecutionTimeline.Step> steps = this.timeline.snapshot().steps();
        int from = Math.max(0, steps.size() - 8);
        for (int i = steps.size() - 1; i >= from; i--) {
            AgentExecutionTimeline.Step step = steps.get(i);
            sb.append("- ").append(step.tool()).append(" [").append(step.state()).append("] ")
                    .append(MessageHistory.truncate(step.summary(), 100)).append('\n');
        }
        List<TaskManager.Task> tasks = this.toolContext.taskManager().list();
        if (!tasks.isEmpty()) {
            sb.append("任务清单：\n");
            for (TaskManager.Task task : tasks) {
                sb.append("- [").append(task.status()).append("] ").append(task.id()).append(": ")
                        .append(task.desc()).append('\n');
            }
        }
        sb.append("请对照任务目标评估进度：目标已完成的步骤直接继续推进；发现偏离时先说明调整理由，再用下一步工具调用继续，不要重复已完成的工作。");
        return sb.toString();
    }

    /** 发送给 API 的消息列表：system + 摘要占位 + 最近 N 条（滑动窗口短期记忆，委托 MessageHistory）。 */
    private List<Map<String, Object>> requestMessages() {
        return this.history.requestMessages();
    }

    /** 会话摘要：messages 超阈值时压缩早期消息（委托 MessageHistory；LLM 摘要失败自动回退本地规则版）。 */
    private void compactHistory() {
        this.history.compactHistory();
    }

    private void saveSessionFile() {
        this.history.saveSessionFile(this.toolContext.projectRoot(), this.sessionId);
    }

    private void loadSessionFile() {
        this.history.loadSessionFile(this.toolContext.projectRoot(), this.sessionId);
    }

    private void deleteSessionFile() {
        this.history.deleteSessionFile(this.toolContext.projectRoot(), this.sessionId);
    }

    private Map<String, Object> systemPrompt() {
        StringBuilder sb = new StringBuilder();
        sb.append("你是 CodeNode 桌面工作台的内嵌 Agent（运行在 Windows 上），帮助用户操作工作台节点图、扫描与分析项目、读写文件、执行命令和代码审查。\n");
        sb.append("可用的本地工具：\n");
        for (AgentToolSpec spec : this.tools.listTools()) {
            sb.append("- ").append(spec.name()).append("：").append(spec.description()).append("\n");
        }
        sb.append("分工与规则：\n");
        sb.append("1. 创建节点用 create_nodes（count 指定数量，connect=true 可串联，nodeKind 可选）；编辑节点（改名/移动/删除/复制/改类型/状态/颜色等）用 workbench_edit；连线用 workbench_connect；分组/解组/展开资源组/增删端口用 workbench_structure；保存工程用 save_project；查看工作台用 get_workbench_model。\n");
        sb.append("2. 扫描/分析项目用 scan_project（applyToWorkbench=true 写入工作台）；应用内编译并运行用 compile_run；实时抓取运行数据用 runtime_trace；写分析 md 节点用 write_analysis_md；操控界面用 ui_control；读文件用 read_file；写文件用 write_file；精确改文件代码用 edit_file；找文件用 find_files；跨文件搜内容用 search_files；列目录用 list_directory；抓网页用 fetch_url；代码审查用 code_review；构建/运行用 execute_shell。\n");
        sb.append("2.1 构建真实项目（Gradle/Maven/纯 Java）用 project_info 识别工程、build_project 构建、run_project 运行（可 trace=true 启动 JFR 实时追踪方法调用）、list_tasks 查看可用任务；这些工具面向工程根目录，path 缺省为当前项目。\n");
        sb.append("2.2 用户要求「分析文档/分析项目」时，用 analyze_project 调用本地软件的工程识别与分析模块（返回构建系统/入口类/源文件清单/逐文件结构摘要），并基于分析结果进行后续制作，不要凭空猜测项目结构。\n");
        sb.append("2.3 大批量修改数据（批量创建/删除节点、批量写文件、批量建资产）用 bulk_edit；该工具会请求用户确认并解释将做什么，确认后再执行。\n");
        sb.append("3. 需要向用户澄清或获取输入时用 ask_user（可给 options）。\n");
        sb.append("4. 当工具找不到文件/节点/项目路径，或需要用户提供信息才能继续时，必须用 ask_user 向用户提问确认。调用 ask_user 后必须等待用户回复（工具会阻塞直到用户回答），拿到回答后再继续后续工作，而不是直接放弃、只说失败或假装成功。\n");
        sb.append("5. 项目操作必须调用工具并以工具返回结果作为回复依据，不要只输出文字。\n");
        sb.append("6. 运行环境是 Windows：禁止使用 ls/find/cat/~/head 等 Unix 命令（不可用），不要用 execute_shell 探索目录，请改用 list_directory/find_files/search_files/scan_project。\n");
        sb.append("7. 工具参数缺省时使用当前项目目录。\n");
        sb.append("8. 仅当请求不涉及上述能力（如闲聊）时才直接文字回复。\n");
        sb.append("9. 复杂任务必须分多步调用工具：每步调用一个工具，根据工具返回结果决定下一步是否继续调用，直到任务完整解决后再输出最终结论。不要在一次工具调用后就停止，除非任务已确实完成。\n");
        sb.append("9.1 工具调用失败或返回空结果时，绝对不要就此停下：先用 get_workbench_model / find_files / search_files / list_directory / project_info 等换一种方式排查，或调整参数、缩小步骤重试；系统也会在失败后提示你继续。只有多种方案都试过仍无法完成时，才用 ask_user 说明情况并请用户协助。\n");
        sb.append("9.2 只有触及敏感操作（删除文件、执行 git 危险命令如 reset/push/clean、跨出项目目录、或超出用户当前请求范围）时才需要用户确认；项目内的普通读写、构建、查询直接执行，不要反复询问。\n");
        sb.append("9.3 若确需用户确认，确认文案必须用自然语言向用户解释你打算做什么（如“我打算修改 src/App.java 中的连接超时配置”），而不是用一串代码或命令字符串提问。\n");
        sb.append("9.4 调用工具时可以自行给 timeoutSeconds 参数设定合理等待时间（默认 60 秒，构建/运行/编译等长任务默认 300 秒，上限 600 秒）；系统会等待工具返回，超时或失败时自动提示你重新思考换方案，不要因为一次失败就停下。\n");
        sb.append("10. 多个工具可在同一轮并发调用（如 read_file + find_files）；工具返回的大结果已被系统截断，请依据结果要点继续，不要假设结果完整。\n");
        sb.append("文件类型解析规则：\n");
        sb.append("11. read_file 只能读取文本文件，且自动检测类型：二进制文件（.class/.png/.jar/.zip/.pdf/.docx/图片/音视频等）会被拒绝并返回类型与解析建议，不要强行读取。\n");
        sb.append("12. .class 字节码文件用 execute_shell 执行 javap -p <路径> 反汇编；归档（.jar/.zip/.cnode）需先解压再分析；图片/文档需专用工具，read_file 无效。\n");
        sb.append("13. 大文件（超过 ").append(this.config.readFileMaxLines()).append(" 行）默认截断读取；想快速了解结构时用 read_file 的 analyze=true 获取导入/类/函数/变量摘要，比读全文更高效。\n");
        sb.append("14. 无法判断文件类型时，先 list_directory 或 find_files 看扩展名与大小，再决定解析方式。\n");
        sb.append("Stage4.5 全量程序扫描与分析规则：\n");
        sb.append("15. 分析项目必须先用 scan_project（mode=hierarchy，applyToWorkbench=true）全量扫描：目录按文件管理器层级成组，资产叶子目录生成资源组（输出端口含每个资产名），程序/配置文件用文件节点并引用相对路径，缓存/构建目录被忽略。\n");
        sb.append("16. 阅读画布：用 get_workbench_model 获取工作台全部节点（id/name/nodeKind/端口/relativePath/所属组），用其理解画布结构与连接关系；get_workbench_model 返回完整节点列表，可据此定位目标节点 id 供其他工具使用。\n");
        sb.append("17. 扫描后调用 decodeArchitecture（由 write_analysis_md 自动生成）得到完整程序分析架构（组/资源组成员/文件/资产的嵌套结构），用最少理解直接基于画布生成分析，不要凭空猜测项目结构。\n");
        sb.append("18. 理解程序运行效果用 compile_run（应用内编译并运行目标作用域代码，不依赖外部 IDE/终端；targetId 给组/组输出/文件/代码节点，mainClass 缺省自动探测）；实时抓取运行数据用 runtime_trace（返回程序/资产清单与输出）；两者超时秒数默认 10，最多 120。\n");
        sb.append("19. 分析结果用 write_analysis_md 写成 Markdown 分析节点（缺省自动从画布生成项目架构），落在已分析项目上供后续节点调用。\n");
        sb.append("20. 需要操控软件本体（缩放/平移/聚焦/查看全部/调整窗口/切换面板/新建内容节点）用 ui_control；节点库按分类切换：资产类节点（图片/模型等）用软件现有预设（create_nodes nodeKind=asset/bundle），程序类用文件节点（nodeKind=file），所有文件节点创建时引用相对路径。\n");
        sb.append("21. 实时数据分析流程：先 scan_project 全量扫描 → write_analysis_md 生成架构 → runtime_trace/compile_run 依据实时运行输出判断应用了什么代码/程序/资产 → 再 write_analysis_md 更新总体架构 md 节点。\n");
        sb.append("长期知识规则：用户提供长文本或要求长期记住时调用 graph_summarize；查找既有知识先 graph_query，再用 graph_path 定位，禁止根据 DSL 名称猜测文件或工具参数。graph_* 返回的结构化字段才是调用依据。\n");
        try {
            List<MemoryStore.Entry> localMemory = this.toolContext.memoryStore().recall("", 3);
            if (!localMemory.isEmpty()) {
                sb.append("\n[Project Markdown memory]\n");
                for (MemoryStore.Entry entry : localMemory) {
                    sb.append("- ").append(entry.title()).append(": ")
                            .append(MessageHistory.truncate(entry.content().replaceAll("\\s+", " "), 420)).append('\n');
                }
            }
        } catch (RuntimeException ignored) { }
        String userMemory = new UserMemoryStore().read();
        if (!userMemory.isBlank()) {
            sb.append("\n[User memory]（跨项目用户级记忆，来自 ~/.codenode/user-memory.md；需要更新时用 user_memory_save）\n")
                    .append(MessageHistory.truncate(userMemory, 1500)).append('\n');
        }
        KnowledgeGraph knowledge = this.toolContext.knowledgeGraph();
        if (!knowledge.pendingConflicts().isEmpty()) {
            sb.append("\n【待确认的长期知识冲突】\n");
            for (KnowledgeGraph.Conflict conflict : knowledge.pendingConflicts()) {
                sb.append("- ").append(conflict.conflictId()).append(" ").append(conflict.field())
                        .append(": ").append(conflict.currentValue()).append(" -> ")
                        .append(conflict.proposedValue()).append("; source ")
                        .append(conflict.currentSource()).append(" -> ").append(conflict.proposedSource()).append('\n');
            }
            sb.append("不要宣称长期知识已更新；先向用户说明冲突，并使用 graph_conflicts/graph_resolve_conflict。\n");
        }
        if (!knowledge.isEmpty()) sb.append("【当前项目长期知识】").append(knowledge.overview()).append("\n");
        List<TaskManager.Task> tasks = this.toolContext.taskManager().list();
        if (!tasks.isEmpty()) {
            sb.append("\n【当前文档任务清单】\n");
            for (TaskManager.Task task : tasks) {
                sb.append("- [").append(task.status()).append("] ").append(task.id()).append(": ")
                        .append(task.desc());
                if (!task.note().isBlank()) sb.append(" — ").append(task.note());
                sb.append('\n');
            }
            sb.append("使用 todo_add/todo_update 维护复杂任务进度；不同对话标签共享此清单。\n");
        }
        sb.append("\n").append(AgentInfoSnapshot.capture(this.toolContext.softwareInfoProvider()).toText()).append("\n");
        if (this.config.extraHarnessPrompt() != null && !this.config.extraHarnessPrompt().isBlank()) {
            sb.append("\n【用户自定义附加规则】\n").append(this.config.extraHarnessPrompt()).append("\n");
        }
        return Map.of("role", "system", "content", sb.toString());
    }

    private void runTurnLoop(ChatListener listener) throws Exception {
        List<Map<String, Object>> toolSchema = this.tools.toOpenAiTools();
        int guard = 0;
        boolean executedTool = false;
        boolean lastRoundHadIssue = false;
        int retryNudges = 0;
        int nextPlanCheckAt = PLAN_CHECK_INTERVAL;
        while (!this.stopRequested && guard++ < MAX_TOOL_LOOP) {
            // 会话 token 预算检查：超限后停止工具调用，直接进入收尾总结（防失控循环超额消耗）
            if (this.sessionScope.budget().exceeded()) {
                this.traceEvent("budget_exceeded", Map.of("round", guard,
                        "used", this.sessionScope.budget().used(), "limit", this.sessionScope.budget().limit()));
                this.history.add(Map.of("role", "user", "content",
                        "【系统提示】会话 token 预算已用尽（" + this.sessionScope.budget().used() + "/"
                                + this.sessionScope.budget().limit() + "），请停止调用工具，直接总结当前进度与结论。"));
                this.saveSessionFile();
                break;
            }
            long chatStart = System.currentTimeMillis();
            Map<String, Object> assistant = this.client.chat(this.requestMessages(), toolSchema, listener::onEvent);
            long chatDuration = System.currentTimeMillis() - chatStart;
            Map<String, Object> usage = this.client.lastUsage();
            this.traceEvent("llm_call", Map.of("round", guard, "durationMs", chatDuration,
                    "usage", usage == null ? Map.of() : usage));
            this.sessionScope.budget().record(usage);
            this.history.add(assistant);
            Object rawCalls = assistant.get("tool_calls");
            if (!(rawCalls instanceof List<?>) || ((List<?>)rawCalls).isEmpty()) {
                // 模型没有继续调用工具：若上一轮工具失败/空结果且未耗尽重试次数，提示继续思考其他方案，
                // 而不是直接停下。
                if (lastRoundHadIssue && !this.stopRequested && retryNudges < MAX_TOOL_RETRY) {
                    retryNudges++;
                    lastRoundHadIssue = false;
                    this.traceEvent("retry_nudge", Map.of("round", guard, "reason", "empty_turn_after_issue"));
                    this.history.add(Map.of("role", "user",
                            "content", "【系统提示】上一轮工具执行失败或返回了空结果，任务尚未完成。请换一种思路继续：尝试不同的工具、不同的参数或更小的步骤，直到真正拿到结果；确实无法完成时再向用户说明。"));
                    this.saveSessionFile();
                    continue;
                }
                break;
            }
            executedTool = true;
            lastRoundHadIssue = false;
            Set<String> expectedCallIds = new LinkedHashSet<String>();
            for (Object callObj : (List<?>)rawCalls) {
                if (callObj instanceof Map<?, ?> call) {
                    Object id = call.get("id");
                    if (id != null) expectedCallIds.add(String.valueOf(id));
                }
            }
            for (Object callObj : (List<?>)rawCalls) {
                Map<String, Object> args;
                Map<String, Object> call;
                if (this.stopRequested) {
                    throw new InterruptedException("已停止");
                }
                if (callObj instanceof Map<?, ?>) {
                    call = AgentChatController.toStringMap((Map<?, ?>)callObj);
                } else {
                    call = Map.of();
                }
                String callId = String.valueOf(call.getOrDefault("id", ""));
                Object v = call.get("function");
                Map<String, Object> function;
                if (v instanceof Map<?, ?>) {
                    function = AgentChatController.toStringMap((Map<?, ?>)v);
                } else {
                    function = Map.of();
                }
                String name = String.valueOf(function.getOrDefault("name", ""));
                String argsJson = String.valueOf(function.getOrDefault("arguments", "{}"));
                try {
                    Object parsed = Json.parse(argsJson);
                    if (parsed instanceof Map<?, ?>) {
                        args = AgentChatController.toStringMap((Map<?, ?>)parsed);
                    } else {
                        args = Map.of();
                    }
                }
                catch (RuntimeException ignored) {
                    args = Map.of();
                }
                // 工具执行：带超时保护 + 单工具异常兜底，回写错误给模型
                String stepId = this.timeline.beginStep(name, "tool call");
                local.codenode.WorkflowModel beforeWorkbench = isWorkbenchMutation(name) ? this.toolContext.snapshotWorkbench() : null;
                long toolStart = System.currentTimeMillis();
                AgentToolResult result;
                try {
                    listener.onEvent(ChatEvent.toolProgress(name));
                    long toolTimeout = this.resolveToolTimeout(name, args);
                    result = this.executeToolWithTimeout(name, args, toolTimeout);
                } catch (Exception toolFailure) {
                    result = AgentToolResult.error("工具执行异常: " + toolFailure.getMessage());
                }
                this.traceEvent("tool_call", Map.of("tool", name, "ok", result.ok(),
                        "durationMs", System.currentTimeMillis() - toolStart,
                        "preview", MessageHistory.truncate(result.text(), 200)));
                listener.onEvent(ChatEvent.state(AgentProvider.SessionState.ACTIVE_RUNNING));
                String resultText = result.ok() ? result.text() : "失败：" + result.text();
                String resultId = this.toolContext.resultStore().store(name, result);
                String structured = this.toolContext.resultStore().modelPayload(resultId, name, result, this.config.maxToolResultChars());
                String preview = MessageHistory.truncate(resultText, 1200);
                boolean reversible = beforeWorkbench != null && result.ok() && this.toolContext.model() != null && this.toolContext.model().revision() != beforeWorkbench.revision();
                // 判定本轮是否出现失败/空结果/超时：失败、空文本、取消、超时都视为未取得有效结果
                boolean issue = !result.ok() || result.text() == null || result.text().isBlank()
                        || result.text().contains("已取消") || result.text().contains("失败")
                        || result.text().contains("超时")
                        || result.text().startsWith("未找到") || result.text().startsWith("没有");
                if (issue) {
                    lastRoundHadIssue = true;
                    listener.onEvent(ChatEvent.reasoning("\n[工具 " + name + "] ⚠ " + preview + "（未取得有效结果，继续尝试其他方案）\n"));
                } else {
                    listener.onEvent(ChatEvent.reasoning("\n[工具 " + name + "] " + preview + "\n"));
                }
                if (issue) {
                    this.timeline.failStep(stepId, preview);
                } else {
                    Runnable undo = reversible ? () -> this.toolContext.restoreWorkbench(beforeWorkbench) : null;
                    this.timeline.completeStep(stepId, resultId, preview, undo);
                }
                LinkedHashMap<String, Object> toolMessage = new LinkedHashMap<String, Object>();
                toolMessage.put("role", "tool");
                toolMessage.put("tool_call_id", callId);
                toolMessage.put("content", structured);
                this.history.add(toolMessage);
            }
            this.saveSessionFile();
            // 本轮执行了工具且存在失败：立即注入"重新思考"提示并继续，而不是等模型主动停下
            if (lastRoundHadIssue && !this.stopRequested && retryNudges < MAX_TOOL_RETRY) {
                retryNudges++;
                lastRoundHadIssue = false;
                this.traceEvent("retry_nudge", Map.of("round", guard, "reason", "tool_issue"));
                this.history.add(Map.of("role", "user",
                        "content", "【系统提示】刚才的工具调用失败或返回空结果，任务尚未完成。请重新思考：换一种工具、调整参数、缩小步骤或换个思路重试，直到真正取得结果；只有多种方案都失败时才向用户说明。"));
                this.saveSessionFile();
            }
            // 规划层：每完成 PLAN_CHECK_INTERVAL 步注入进度检查，防止长任务中途偏离目标
            int doneSteps = this.timeline.snapshot().steps().size();
            if (!this.stopRequested && doneSteps >= nextPlanCheckAt) {
                nextPlanCheckAt = doneSteps + PLAN_CHECK_INTERVAL;
                this.traceEvent("plan_check", Map.of("steps", doneSteps));
                this.history.add(Map.of("role", "user", "content", this.planCheckPrompt(doneSteps)));
                this.saveSessionFile();
            }
            if (this.history.needsCompaction()) {
                this.compactHistory();
                this.saveSessionFile();
            }
        }
        // 强制总结：执行过工具后，补一轮"请总结"请求，确保用户始终收到最终答案
        // （覆盖 ask_user 返回答案后模型不继续、以及模型中途停下的情况）。
        if (!this.stopRequested && executedTool) {
            this.timeline.verify();
            Map<String, Object> summaryRequest = Map.of("role", "user",
                    "content", "请基于以上工具执行结果与用户提供的回答，总结本次任务的结论，并给出清晰、完整的最终答案回复给用户。注意：你的回复内容本身就会直接展示给用户，请务必把最终答案写在回复正文（content）中，不要只放在推理里。");
            this.history.add(summaryRequest);
            if (guard < MAX_TOOL_LOOP) {
                Map<String, Object> finalAssistant = this.client.chat(this.requestMessages(), toolSchema, listener::onEvent);
                this.history.add(finalAssistant);
                this.saveSessionFile();
            }
        } else if (!this.stopRequested && this.history.size() > 0) {
            // 未调用工具也检查：若最后一条 assistant 只有推理没有正文，把推理结论作为正式答案输出，
            // 避免"想出了答案却不显示"。
            Map<String, Object> last = this.history.last();
            if ("assistant".equals(last.get("role"))
                    && (last.get("content") == null || String.valueOf(last.get("content")).isBlank())
                    && last.get("reasoning") != null
                    && !String.valueOf(last.get("reasoning")).isBlank()) {
                String fallback = String.valueOf(last.get("reasoning")).trim();
                listener.onEvent(ChatEvent.stream("\n" + fallback + "\n"));
            }
        }
    }

    /** 移除已迁移到 MessageHistory 的静态工具方法（truncate/adjustWindowStart/sanitize 已委托）。 */

    /**
     * 带超时执行单个工具：在独立线程运行，超过 timeoutSeconds 未返回则视为超时失败。
     * 超时结果回写为"工具执行超时"，让模型重新思考换方案。
     */
    private AgentToolResult executeToolWithTimeout(String name, Map<String, Object> args, long timeoutSeconds) {
        this.sessionScope.clearToolStop();
        Future<AgentToolResult> future = this.toolExecutor.submit(() -> {
            this.toolContext.setSubagentManager(this.subagentManager());
            try { return this.tools.execute(name, args, this.toolContext, this.sessionScope); }
            finally { this.toolContext.setSubagentManager(null); }
        });
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);
            while (true) {
                if (this.stopRequested || this.sessionScope.toolStopRequested()) { future.cancel(true); return AgentToolResult.error("工具已取消：" + name); }
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) throw new TimeoutException();
                try { return future.get(Math.min(TimeUnit.NANOSECONDS.toMillis(remaining), 250), TimeUnit.MILLISECONDS); }
                catch (TimeoutException tick) { }
            }
        } catch (TimeoutException timeout) {
            future.cancel(true);
            return AgentToolResult.error("工具执行超时（超过 " + timeoutSeconds + " 秒）：" + name
                    + "。请换更小的步骤、不同的参数或换一个工具重试。");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return AgentToolResult.error("工具执行被中断：" + name);
        } catch (ExecutionException execution) {
            Throwable cause = execution.getCause() == null ? execution : execution.getCause();
            return AgentToolResult.error("工具执行异常: " + cause.getMessage());
        }
    }

    /**
     * 根据工具名与参数解析合理超时：优先取参数 timeoutSeconds（Agent 可自行设定），
     * 长耗时工具（构建/运行/编译/抓包/扫描）给长默认值，其余给短默认值。
     */
    private long resolveToolTimeout(String name, Map<String, Object> args) {
        Object explicit = args == null ? null : args.get("timeoutSeconds");
        if (explicit instanceof Number n) {
            return Math.max(1, Math.min(600, n.longValue()));
        }
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.contains("build") || lower.contains("run") || lower.contains("compile")
                || lower.contains("trace") || lower.contains("scan") || lower.contains("fetch")
                || lower.contains("shell") || lower.contains("url")) {
            return LONG_TOOL_TIMEOUT_SECONDS;
        }
        return DEFAULT_TOOL_TIMEOUT_SECONDS;
    }

    /** 防御：移除 messages 中孤立的 tool 消息（已委托 MessageHistory.sanitizeToolMessages）。 */

    public void requestStop() {
        if (this.state != AgentProvider.SessionState.ACTIVE_RUNNING) {
            return;
        }
        this.stopRequested = true;
        this.timeline.cancelTask();
        this.sessionScope.requestToolStop();
        this.client.abort();
    }

    public void requestToolStop() { this.sessionScope.requestToolStop(); }
    public void setRememberApprovals(boolean remember) { this.toolContext.setRememberApprovals(remember); }
    public AgentInfoSnapshot infoSnapshot() { return AgentInfoSnapshot.capture(this.toolContext.softwareInfoProvider());
    }

    private static boolean isWorkbenchMutation(String name) {
        return switch (name == null ? "" : name) {
            case "create_nodes", "workbench_edit", "workbench_connect", "workbench_structure", "ui_control" -> true;
            default -> false;
        };
    }

    private static Map<String, Object> toStringMap(Map<?, ?> map) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<String, Object>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }
}
