package local.codenode.agent;

import local.codenode.AgentProvider;
import local.codenode.Json;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.config.AgentConfig;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 会话状态机 / 取消 / 工具调度（Stage4.5）。
 * 状态：IDLE → ACTIVE_RUNNING → IDLE；requestStop → CANCELLED → IDLE。
 * 多轮会话维护消息历史；模型触发 tool_calls 时经 AgentToolRegistry 本地执行并回传结果。
 */
public final class AgentChatController {
    private static final int MAX_TOOL_LOOP = 10;

    private final AgentConfig config;
    private final OpenAiChatClient client;
    private final AgentToolRegistry tools;
    private final AgentToolContext toolContext;
    private final List<Map<String, Object>> messages = new ArrayList<>();
    private volatile AgentProvider.SessionState state = AgentProvider.SessionState.IDLE;
    private volatile boolean stopRequested;

    public AgentChatController(AgentConfig config, AgentToolRegistry tools, AgentToolContext toolContext) {
        this.config = config;
        this.client = new OpenAiChatClient(config);
        this.tools = tools;
        this.toolContext = toolContext;
    }

    public AgentProvider.SessionState state() {
        return state;
    }

    public OpenAiChatClient client() {
        return client;
    }

    public AgentToolRegistry tools() {
        return tools;
    }

    /** 清空会话历史并回到 IDLE。 */
    public void reset() {
        messages.clear();
        state = AgentProvider.SessionState.IDLE;
        stopRequested = false;
    }

    public List<Map<String, Object>> messageHistory() {
        return List.copyOf(messages);
    }

    /** 发送一条用户消息并启动工具循环；结果经 listener 事件推送。 */
    public void sendMessage(String userText, ChatListener listener) {
        if (state != AgentProvider.SessionState.IDLE) {
            listener.onEvent(ChatEvent.error("上一条消息仍在处理中，请先停止或等待完成"));
            return;
        }
        if (userText == null || userText.isBlank()) return;
        if (messages.isEmpty()) {
            messages.add(systemPrompt());
        }
        state = AgentProvider.SessionState.ACTIVE_RUNNING;
        stopRequested = false;
        listener.onEvent(ChatEvent.state(state));
        messages.add(Map.of("role", "user", "content", userText));
        Thread.startVirtualThread(() -> {
            try {
                runTurnLoop(listener);
            } catch (InterruptedException interrupted) {
                listener.onEvent(ChatEvent.cancelled());
            } catch (Exception failure) {
                listener.onEvent(ChatEvent.error(failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage()));
            } finally {
                state = AgentProvider.SessionState.IDLE;
                listener.onEvent(ChatEvent.state(state));
            }
        });
    }

    /** 会话级系统提示：声明可用工具并强制在项目操作时调用，避免模型只回文字。 */
    private Map<String, Object> systemPrompt() {
        StringBuilder sb = new StringBuilder();
        sb.append("你是 CodeNode 桌面工作台的内嵌 Agent（运行在 Windows 上），帮助用户操作工作台节点图、扫描与分析项目、读写文件、执行命令和代码审查。\n");
        sb.append("可用的本地工具：\n");
        for (local.codenode.agent.tools.AgentToolSpec spec : tools.listTools()) {
            sb.append("- ").append(spec.name()).append("：").append(spec.description()).append("\n");
        }
        sb.append("分工与规则：\n");
        sb.append("1. 创建节点用 create_nodes（count 指定数量，connect=true 可串联，nodeKind 可选）；编辑节点（改名/移动/删除/复制/改类型/状态/颜色等）用 workbench_edit；连线用 workbench_connect；分组/解组/展开资源组/增删端口用 workbench_structure；保存工程用 save_project；查看工作台用 get_workbench_model。\n");
        sb.append("2. 扫描/分析项目用 scan_project（applyToWorkbench=true 写入工作台）；读文件用 read_file；写文件用 write_file；精确改文件代码用 edit_file；找文件用 find_files；跨文件搜内容用 search_files；列目录用 list_directory；抓网页用 fetch_url；代码审查用 code_review；构建/运行用 execute_shell。\n");
        sb.append("3. 需要向用户澄清或获取输入时用 ask_user（可给 options）。\n");
        sb.append("4. 当工具找不到文件/节点/项目路径，或需要用户提供信息才能继续时，必须用 ask_user 向用户提问确认，而不是直接放弃、只说失败或假装成功。\n");
        sb.append("5. 项目操作必须调用工具并以工具返回结果作为回复依据，不要只输出文字。\n");
        sb.append("6. 运行环境是 Windows：禁止使用 ls/find/cat/~/head 等 Unix 命令（不可用），不要用 execute_shell 探索目录，请改用 list_directory/find_files/search_files/scan_project。\n");
        sb.append("7. 工具参数缺省时使用当前项目目录。\n");
        sb.append("8. 仅当请求不涉及上述能力（如闲聊）时才直接文字回复。\n");
        return Map.of("role", "system", "content", sb.toString());
    }

    private void runTurnLoop(ChatListener listener) throws Exception {
        List<Map<String, Object>> toolSchema = tools.toOpenAiTools();
        int guard = 0;
        while (!stopRequested && guard++ < MAX_TOOL_LOOP) {
            Map<String, Object> assistant = client.chat(messages, toolSchema, listener::onEvent);
            messages.add(assistant);
            Object rawCalls = assistant.get("tool_calls");
            if (!(rawCalls instanceof List<?> calls) || calls.isEmpty()) break;
            for (Object callObj : calls) {
                if (stopRequested) throw new InterruptedException("已停止");
                Map<String, Object> call = callObj instanceof Map<?, ?> map ? toStringMap(map) : Map.of();
                String callId = String.valueOf(call.getOrDefault("id", ""));
                Map<String, Object> function = call.get("function") instanceof Map<?, ?> map ? toStringMap(map) : Map.of();
                String name = String.valueOf(function.getOrDefault("name", ""));
                String argsJson = String.valueOf(function.getOrDefault("arguments", "{}"));
                Map<String, Object> args;
                try {
                    Object parsed = Json.parse(argsJson);
                    args = parsed instanceof Map<?, ?> map ? toStringMap(map) : Map.of();
                } catch (RuntimeException ignored) {
                    args = Map.of();
                }
                AgentToolResult result = tools.execute(name, args, toolContext);
                String summary = result.ok() ? result.text() : "失败：" + result.text();
                listener.onEvent(ChatEvent.stream("\n[工具 " + name + "] " + summary + "\n"));
                Map<String, Object> toolMessage = new LinkedHashMap<>();
                toolMessage.put("role", "tool");
                toolMessage.put("tool_call_id", callId);
                toolMessage.put("content", result.ok() ? result.text() : "执行失败：" + result.text());
                messages.add(toolMessage);
            }
        }
    }

    /** 请求停止：置停止标志并中止当前 HTTP 流。 */
    public void requestStop() {
        if (state != AgentProvider.SessionState.ACTIVE_RUNNING) return;
        stopRequested = true;
        client.abort();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> toStringMap(Map<?, ?> map) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }
}
