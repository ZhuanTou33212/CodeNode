package local.codenode.agent.components;

import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.MessageHistory;
import local.codenode.agent.MemoryStore;
import local.codenode.agent.TaskManager;
import local.codenode.agent.UserMemoryStore;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.tools.AgentToolSpec;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 内置系统提示分段（从 {@code AgentChatController.systemPrompt} 原样拆出，
 * 默认配置下渲染结果与改造前逐字节一致）。
 *
 * <p>段清单：role / file_rules / scan_rules / knowledge_rules /
 * project_memory / user_memory / knowledge_state / tasks / agent_info / extra。</p>
 */
public final class PromptSections {

    private PromptSections() {
    }

    /** 全部内置段（name -> section）。 */
    public static Map<String, PromptSection> builtin() {
        Map<String, PromptSection> sections = new LinkedHashMap<>();
        sections.put("role", role());
        sections.put("file_rules", fileRules());
        sections.put("scan_rules", scanRules());
        sections.put("knowledge_rules", knowledgeRules());
        sections.put("project_memory", projectMemory());
        sections.put("user_memory", userMemory());
        sections.put("knowledge_state", knowledgeState());
        sections.put("tasks", tasks());
        sections.put("agent_info", agentInfo());
        sections.put("extra", extra());
        return sections;
    }

    /** 角色定位 + 工具分工与规则 1-10。 */
    static PromptSection role() {
        return PromptSection.of("role", ctx -> {
            StringBuilder sb = new StringBuilder();
            sb.append("你是 CodeNode 桌面工作台的内嵌 Agent（运行在 Windows 上），帮助用户操作工作台节点图、扫描与分析项目、读写文件、执行命令和代码审查。\n");
            sb.append("可用的本地工具：\n");
            for (AgentToolSpec spec : ctx.tools().listTools()) {
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
            sb.append("9.4 调用工具时可以自行给 timeoutSeconds 参数设定合理等待时间（默认 ")
                    .append(ctx.config().loopDefaultTimeoutSeconds()).append(" 秒，构建/运行/编译等长任务默认 ")
                    .append(ctx.config().loopLongTimeoutSeconds()).append(" 秒，上限 600 秒）；系统会等待工具返回，超时或失败时自动提示你重新思考换方案，不要因为一次失败就停下。\n");
            sb.append("10. 多个工具可在同一轮并发调用（如 read_file + find_files）；工具返回的大结果已被系统截断，请依据结果要点继续，不要假设结果完整。\n");
            return sb.toString();
        });
    }

    /** 文件类型解析规则 11-14（独立段，默认包含在 role 之后）。 */
    static PromptSection fileRules() {
        return PromptSection.of("file_rules", ctx -> {
            StringBuilder sb = new StringBuilder();
            sb.append("文件类型解析规则：\n");
            sb.append("11. read_file 只能读取文本文件，且自动检测类型：二进制文件（.class/.png/.jar/.zip/.pdf/.docx/图片/音视频等）会被拒绝并返回类型与解析建议，不要强行读取。\n");
            sb.append("12. .class 字节码文件用 execute_shell 执行 javap -p <路径> 反汇编；归档（.jar/.zip/.cnode）需先解压再分析；图片/文档需专用工具，read_file 无效。\n");
            sb.append("13. 大文件（超过 ").append(ctx.config().readFileMaxLines()).append(" 行）默认截断读取；想快速了解结构时用 read_file 的 analyze=true 获取导入/类/函数/变量摘要，比读全文更高效。\n");
            sb.append("14. 无法判断文件类型时，先 list_directory 或 find_files 看扩展名与大小，再决定解析方式。\n");
            return sb.toString();
        });
    }

    /** Stage4.5 全量扫描与分析规则 15-21。 */
    static PromptSection scanRules() {
        return PromptSection.of("scan_rules", ctx -> {
            StringBuilder sb = new StringBuilder();
            sb.append("Stage4.5 全量程序扫描与分析规则：\n");
            sb.append("15. 分析项目必须先用 scan_project（mode=hierarchy，applyToWorkbench=true）全量扫描：目录按文件管理器层级成组，资产叶子目录生成资源组（输出端口含每个资产名），程序/配置文件用文件节点并引用相对路径，缓存/构建目录被忽略。\n");
            sb.append("16. 阅读画布：用 get_workbench_model 获取工作台全部节点（id/name/nodeKind/端口/relativePath/所属组），用其理解画布结构与连接关系；get_workbench_model 返回完整节点列表，可据此定位目标节点 id 供其他工具使用。\n");
            sb.append("17. 扫描后调用 decodeArchitecture（由 write_analysis_md 自动生成）得到完整程序分析架构（组/资源组成员/文件/资产的嵌套结构），用最少理解直接基于画布生成分析，不要凭空猜测项目结构。\n");
            sb.append("18. 理解程序运行效果用 compile_run（应用内编译并运行目标作用域代码，不依赖外部 IDE/终端；targetId 给组/组输出/文件/代码节点，mainClass 缺省自动探测）；实时抓取运行数据用 runtime_trace（返回程序/资产清单与输出）；两者超时秒数默认 10，最多 120。\n");
            sb.append("19. 分析结果用 write_analysis_md 写成 Markdown 分析节点（缺省自动从画布生成项目架构），落在已分析项目上供后续节点调用。\n");
            sb.append("20. 需要操控软件本体（缩放/平移/聚焦/查看全部/调整窗口/切换面板/新建内容节点）用 ui_control；节点库按分类切换：资产类节点（图片/模型等）用软件现有预设（create_nodes nodeKind=asset/bundle），程序类用文件节点（nodeKind=file），所有文件节点创建时引用相对路径。\n");
            sb.append("21. 实时数据分析流程：先 scan_project 全量扫描 → write_analysis_md 生成架构 → runtime_trace/compile_run 依据实时运行输出判断应用了什么代码/程序/资产 → 再 write_analysis_md 更新总体架构 md 节点。\n");
            return sb.toString();
        });
    }

    /** 长期知识规则。 */
    static PromptSection knowledgeRules() {
        return PromptSection.of("knowledge_rules", ctx ->
                "长期知识规则：用户提供长文本或要求长期记住时调用 graph_summarize；查找既有知识先 graph_query，再用 graph_path 定位，禁止根据 DSL 名称猜测文件或工具参数。graph_* 返回的结构化字段才是调用依据。\n");
    }

    /** 项目 Markdown 记忆（最近 3 条，按相关性检索）。 */
    static PromptSection projectMemory() {
        return PromptSection.of("project_memory", ctx -> {
            try {
                List<MemoryStore.Entry> localMemory = ctx.toolContext().memoryStore().recall("", 3);
                if (localMemory.isEmpty()) return "";
                StringBuilder sb = new StringBuilder("\n[Project Markdown memory]\n");
                for (MemoryStore.Entry entry : localMemory) {
                    sb.append("- ").append(entry.title()).append(": ")
                            .append(MessageHistory.truncate(entry.content().replaceAll("\\s+", " "), 420)).append('\n');
                }
                return sb.toString();
            } catch (RuntimeException ignored) {
                return "";
            }
        });
    }

    /** 跨项目用户记忆（~/.codenode/user-memory.md）。 */
    static PromptSection userMemory() {
        return PromptSection.of("user_memory", ctx -> {
            String userMemory = new UserMemoryStore().read();
            if (userMemory.isBlank()) return "";
            return "\n[User memory]（跨项目用户级记忆，来自 ~/.codenode/user-memory.md；需要更新时用 user_memory_save）\n"
                    + MessageHistory.truncate(userMemory, 1500) + "\n";
        });
    }

    /** 长期知识状态：待确认冲突 + 当前项目知识概览。 */
    static PromptSection knowledgeState() {
        return PromptSection.of("knowledge_state", ctx -> {
            KnowledgeGraph knowledge = ctx.toolContext().knowledgeGraph();
            StringBuilder sb = new StringBuilder();
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
            if (!knowledge.isEmpty()) {
                sb.append("【当前项目长期知识】").append(knowledge.overview()).append("\n");
            }
            return sb.toString();
        });
    }

    /** 当前文档任务清单。 */
    static PromptSection tasks() {
        return PromptSection.of("tasks", ctx -> {
            List<TaskManager.Task> tasks = ctx.toolContext().taskManager().list();
            if (tasks.isEmpty()) return "";
            StringBuilder sb = new StringBuilder("\n【当前文档任务清单】\n");
            for (TaskManager.Task task : tasks) {
                sb.append("- [").append(task.status()).append("] ").append(task.id()).append(": ")
                        .append(task.desc());
                if (!task.note().isBlank()) sb.append(" — ").append(task.note());
                sb.append('\n');
            }
            sb.append("使用 todo_add/todo_update 维护复杂任务进度；不同对话标签共享此清单。\n");
            return sb.toString();
        });
    }

    /** 软件环境信息快照。 */
    static PromptSection agentInfo() {
        return PromptSection.of("agent_info", ctx ->
                "\n" + AgentInfoSnapshot.capture(ctx.toolContext().softwareInfoProvider()).toText() + "\n");
    }

    /** 用户自定义附加规则（harness.extra_prompt）。 */
    static PromptSection extra() {
        return PromptSection.of("extra", ctx -> {
            String extra = ctx.config().extraHarnessPrompt();
            if (extra == null || extra.isBlank()) return "";
            return "\n【用户自定义附加规则】\n" + extra + "\n";
        });
    }
}
