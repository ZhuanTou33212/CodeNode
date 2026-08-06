package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** ask_user：向用户提问并等待回答（options 提供候选选项，否则自由输入）。 */
public final class AskUserTool {

    private AskUserTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "ask_user",
            "向用户提问并等待回答。question 必填；options 可给出候选选项（用户选择其一），否则用户自由输入。",
            Map.of("type", "object",
                "properties", Map.of(
                    "question", Map.of("type", "string", "description", "要问用户的问题"),
                    "options", Map.of("type", "array", "items", Map.of("type", "string"), "description", "候选选项")),
                "required", List.of("question")),
            AskUserTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String question = String.valueOf(arguments.getOrDefault("question", "")).trim();
        if (question.isBlank()) return AgentToolResult.error("缺少 question");
        List<String> options = new ArrayList<>();
        if (arguments.get("options") instanceof List<?> list) {
            for (Object item : list) {
                if (item != null && !String.valueOf(item).isBlank()) options.add(String.valueOf(item));
            }
        }
        String answer = context.askUser(question, options);
        if (answer == null || answer.isBlank()) return AgentToolResult.error("用户未回答（已取消）");
        context.audit("ask_user " + question + " => " + answer);
        return AgentToolResult.ok("用户回答：" + answer, Map.of("answer", answer));
    }
}
