package local.codenode.agent.components;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 系统提示装配器：按配置选择/排序分段组件并渲染为 system 消息
 * （对应 DeepSeek Harness 的 prompt/context 组装）。
 */
public final class PromptAssembler {

    /** 全部内置段（默认顺序，与改造前 systemPrompt 输出顺序一致）。 */
    public static final List<String> DEFAULT_SECTIONS = List.of(
            "role", "file_rules", "scan_rules", "knowledge_rules",
            "project_memory", "user_memory", "knowledge_state", "tasks",
            "agent_info", "extra");

    private final List<PromptSection> sections;

    public PromptAssembler(List<PromptSection> sections) {
        this.sections = sections == null ? List.of() : List.copyOf(sections);
    }

    public List<String> sectionNames() {
        return sections.stream().map(PromptSection::name).toList();
    }

    /** 渲染为 system 消息；未启用任何段时 content 为空串。 */
    public Map<String, Object> render(PromptContext ctx) {
        StringBuilder sb = new StringBuilder();
        for (PromptSection section : sections) {
            String text = section.render(ctx);
            if (text != null && !text.isBlank()) sb.append(text);
        }
        return Map.of("role", "system", "content", sb.toString());
    }

    /** 全部内置段（默认行为）。 */
    public static PromptAssembler defaultAssembler() {
        return fromNames(DEFAULT_SECTIONS);
    }

    /** 空装配器（prompt 组件被禁用时使用）。 */
    public static PromptAssembler empty() {
        return new PromptAssembler(List.of());
    }

    /** 按内置段名列表装配；未知段名忽略（配置容错）；空列表回退全部内置段。 */
    public static PromptAssembler fromNames(List<String> names) {
        if (names == null || names.isEmpty()) return defaultAssembler();
        Map<String, PromptSection> all = PromptSections.builtin();
        List<PromptSection> selected = new ArrayList<>();
        for (String name : names) {
            PromptSection section = all.get(name == null ? "" : name.trim());
            if (section != null) selected.add(section);
        }
        return new PromptAssembler(selected);
    }
}
