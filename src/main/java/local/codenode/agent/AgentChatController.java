/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import local.codenode.AgentProvider;
import local.codenode.Json;
import local.codenode.agent.ChatEvent;
import local.codenode.agent.ChatListener;
import local.codenode.agent.OpenAiChatClient;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.AgentToolSpec;
import local.codenode.config.AgentConfig;

public final class AgentChatController {
    private static final int MAX_TOOL_LOOP = 10;
    private final AgentConfig config;
    private final OpenAiChatClient client;
    private final AgentToolRegistry tools;
    private final AgentToolContext toolContext;
    private final List<Map<String, Object>> messages = new ArrayList<Map<String, Object>>();
    private volatile AgentProvider.SessionState state = AgentProvider.SessionState.IDLE;
    private volatile boolean stopRequested;

    public AgentChatController(AgentConfig config, AgentToolRegistry tools, AgentToolContext toolContext) {
        this.config = config;
        this.client = new OpenAiChatClient(config);
        this.tools = tools;
        this.toolContext = toolContext;
    }

    public AgentProvider.SessionState state() {
        return this.state;
    }

    public OpenAiChatClient client() {
        return this.client;
    }

    public AgentToolRegistry tools() {
        return this.tools;
    }

    public void reset() {
        this.messages.clear();
        this.state = AgentProvider.SessionState.IDLE;
        this.stopRequested = false;
    }

    public List<Map<String, Object>> messageHistory() {
        return List.copyOf(this.messages);
    }

    public void sendMessage(String userText, ChatListener listener) {
        if (this.state != AgentProvider.SessionState.IDLE) {
            listener.onEvent(ChatEvent.error("上一条消息仍在处理中，请先停止或等待完成"));
            return;
        }
        if (userText == null || userText.isBlank()) {
            return;
        }
        if (this.messages.isEmpty()) {
            this.messages.add(this.systemPrompt());
        }
        this.state = AgentProvider.SessionState.ACTIVE_RUNNING;
        this.stopRequested = false;
        listener.onEvent(ChatEvent.state(this.state));
        this.messages.add(Map.of("role", "user", "content", userText));
        Thread.startVirtualThread(() -> {
            try {
                this.runTurnLoop(listener);
            }
            catch (InterruptedException interrupted) {
                listener.onEvent(ChatEvent.cancelled());
            }
            catch (Exception failure) {
                listener.onEvent(ChatEvent.error(failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage()));
            }
            finally {
                this.state = AgentProvider.SessionState.IDLE;
                listener.onEvent(ChatEvent.state(this.state));
            }
        });
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
        sb.append("3. 需要向用户澄清或获取输入时用 ask_user（可给 options）。\n");
        sb.append("4. 当工具找不到文件/节点/项目路径，或需要用户提供信息才能继续时，必须用 ask_user 向用户提问确认，而不是直接放弃、只说失败或假装成功。\n");
        sb.append("5. 项目操作必须调用工具并以工具返回结果作为回复依据，不要只输出文字。\n");
        sb.append("6. 运行环境是 Windows：禁止使用 ls/find/cat/~/head 等 Unix 命令（不可用），不要用 execute_shell 探索目录，请改用 list_directory/find_files/search_files/scan_project。\n");
        sb.append("7. 工具参数缺省时使用当前项目目录。\n");
        sb.append("8. 仅当请求不涉及上述能力（如闲聊）时才直接文字回复。\n");
        sb.append("文件类型解析规则：\n");
        sb.append("9. read_file 只能读取文本文件，且自动检测类型：二进制文件（.class/.png/.jar/.zip/.pdf/.docx/图片/音视频等）会被拒绝并返回类型与解析建议，不要强行读取。\n");
        sb.append("10. .class 字节码文件用 execute_shell 执行 javap -p <路径> 反汇编；归档（.jar/.zip/.cnode）需先解压再分析；图片/文档需专用工具，read_file 无效。\n");
        sb.append("11. 大文件（超过 ").append(this.config.readFileMaxLines()).append(" 行）默认截断读取；想快速了解结构时用 read_file 的 analyze=true 获取导入/类/函数/变量摘要，比读全文更高效。\n");
        sb.append("12. 无法判断文件类型时，先 list_directory 或 find_files 看扩展名与大小，再决定解析方式。\n");
        sb.append("Stage4.5 全量程序扫描与分析规则：\n");
        sb.append("13. 分析项目必须先用 scan_project（mode=hierarchy，applyToWorkbench=true）全量扫描：目录按文件管理器层级成组，资产叶子目录生成资源组（输出端口含每个资产名），程序/配置文件用文件节点并引用相对路径，缓存/构建目录被忽略。扫描后可直接用 workbench_structure action=ungroup_bundle 把资源组解组为普通组进组视图查看全部资产。\n");
        sb.append("14. 扫描后调用 decodeArchitecture（由 get_workbench_model 的架构信息或 write_analysis_md 自动生成）得到完整程序分析架构（组/资源组成员/文件/资产的嵌套结构），用最少理解直接基于画布生成分析，不要凭空猜测项目结构。\n");
        sb.append("15. 理解程序运行效果用 compile_run（应用内编译并运行目标作用域代码，不依赖外部 IDE/终端；targetId 给组/组输出/文件/代码节点，mainClass 缺省自动探测）；实时抓取运行数据用 runtime_trace（返回程序/资产清单与输出）；两者超时秒数默认 10，最多 120。\n");
        sb.append("16. 分析结果用 write_analysis_md 写成 Markdown 分析节点（缺省自动从画布生成项目架构），落在已分析项目上供后续节点调用。\n");
        sb.append("17. 需要操控软件本体（缩放/平移/聚焦/查看全部/调整窗口/切换面板/新建内容节点）用 ui_control；节点库按分类切换：资产类节点（图片/模型等）用软件现有预设（create_nodes nodeKind=asset/bundle），程序类用文件节点（nodeKind=file），所有文件节点创建时引用相对路径。\n");
        sb.append("18. 实时数据分析流程：先 scan_project 全量扫描 → write_analysis_md 生成架构 → runtime_trace/compile_run 依据实时运行输出判断应用了什么代码/程序/资产 → 再 write_analysis_md 更新总体架构 md 节点。\n");
        if (this.config.extraHarnessPrompt() != null && !this.config.extraHarnessPrompt().isBlank()) {
            sb.append("\n【用户自定义附加规则】\n").append(this.config.extraHarnessPrompt()).append("\n");
        }
        return Map.of("role", "system", "content", sb.toString());
    }

    private void runTurnLoop(ChatListener listener) throws Exception {
        List<Map<String, Object>> toolSchema = this.tools.toOpenAiTools();
        int guard = 0;
        while (!this.stopRequested && guard++ < 10) {
            List calls;
            Map<String, Object> assistant = this.client.chat(this.messages, toolSchema, listener::onEvent);
            this.messages.add(assistant);
            Object rawCalls = assistant.get("tool_calls");
            if (!(rawCalls instanceof List) || (calls = (List)rawCalls).isEmpty()) break;
            for (Object callObj : calls) {
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
                AgentToolResult result = this.tools.execute(name, args, this.toolContext);
                Object summary = result.ok() ? result.text() : "失败：" + result.text();
                listener.onEvent(ChatEvent.stream("\n[工具 " + name + "] " + (String)summary + "\n"));
                LinkedHashMap<String, Object> toolMessage = new LinkedHashMap<String, Object>();
                toolMessage.put("role", "tool");
                toolMessage.put("tool_call_id", callId);
                toolMessage.put("content", result.ok() ? result.text() : "执行失败：" + result.text());
                this.messages.add(toolMessage);
            }
        }
    }

    public void requestStop() {
        if (this.state != AgentProvider.SessionState.ACTIVE_RUNNING) {
            return;
        }
        this.stopRequested = true;
        this.client.abort();
    }

    private static Map<String, Object> toStringMap(Map<?, ?> map) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<String, Object>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }
}
